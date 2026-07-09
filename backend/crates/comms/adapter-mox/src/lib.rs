//! mox mail-server transport adapter for webmail.
//!
//! This is the "our own server" transport for the webmail surface, riding mox's
//! HTTP/JSON **webapi** (github.com/mjl-/mox) instead of raw SMTP/IMAP:
//!
//! * **Outbound send** ([`MoxWebapiSender`]) implements the [`SmtpSender`] port
//!   over `POST {base}/webapi/v0/Send` with HTTP Basic auth (the tenant's mox
//!   account login = the SMTP username/password already on the account). The
//!   request is a URL-encoded `request=<json>` form (mox's documented
//!   non-multipart shape); the response yields the stamped `Message-ID`.
//! * **Inbound delivery** ([`Incoming`]) is mox's webhook payload for an arriving
//!   message. [`Incoming::to_fetched_message`] maps it into the mail domain's
//!   [`FetchedMessage`] so the REST webhook receiver can UPSERT it into the read
//!   model through the existing inbound store — no IMAP poll needed for new mail.
//!
//! Which path each operation uses (slice 1):
//!   * send  → mox webapi (`/webapi/v0/Send`)              — this crate
//!   * new inbound / read-model ingest → mox webhook       — this crate + rest
//!   * folder/backfill IMAP sync against mox               → DEFERRED (mox speaks
//!     IMAP4rev2, but its localserve dev ports (1143/1993) sit outside the app's
//!     IMAP port allowlist + TLS enforcement; wiring that is a later slice).
//!
//! # TLS
//! The workspace `reqwest` ships with no TLS backend, so this adapter speaks
//! plaintext HTTP to a trusted, network-local mox (the dev-stack default and the
//! in-cluster prod topology where mox is not internet-exposed). An HTTPS base
//! URL needs a `reqwest` rustls feature — deferred with the prod k8s manifests.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_comms_application::{
    FetchedMessage, MailFuture, MailServiceError, SendMessageCommand, SmtpSender,
    SmtpTransportConfig, TestConnectionResult,
};
use mnt_comms_domain::MessageAddress;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// The mox webapi transport. `base_url` is the trusted mox origin (e.g.
/// `http://mox:1080` in the dev stack); the per-tenant login (mox account) is
/// carried on the [`SmtpTransportConfig`] as the SMTP username/password.
#[derive(Debug, Clone)]
pub struct MoxWebapiSender {
    base_url: String,
    client: reqwest::Client,
}

impl MoxWebapiSender {
    /// Build a sender for the mox instance at `base_url` (scheme + host + port,
    /// no trailing slash required).
    #[must_use]
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            client: reqwest::Client::new(),
        }
    }

    fn send_url(&self) -> String {
        format!("{}/webapi/v0/Send", self.base_url)
    }
}

impl SmtpSender for MoxWebapiSender {
    fn test_connection<'a>(
        &'a self,
        config: &'a SmtpTransportConfig,
    ) -> MailFuture<'a, Result<TestConnectionResult, MailServiceError>> {
        Box::pin(async move {
            // Reachability + auth probe: a basic-auth GET to the webapi base.
            // mox answers authenticated requests here with 2xx; wrong credentials
            // get 401/403 (still a successful HTTP round-trip, just not authed) —
            // only a genuine 2xx counts as `ok`. A transport error means the
            // server is unreachable.
            // ponytail: reachability probe, not a deep credential check — the
            // webapi has no dedicated no-op auth endpoint and we must not send.
            let resp = self
                .client
                .get(format!("{}/webapi/v0/", self.base_url))
                .basic_auth(&config.username, Some(config.password.expose_secret()))
                .send()
                .await;
            match resp {
                Ok(resp) if resp.status().is_success() => Ok(TestConnectionResult {
                    ok: true,
                    error_code: None,
                }),
                Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
                    Ok(TestConnectionResult {
                        ok: false,
                        error_code: Some("auth_failed".to_owned()),
                    })
                }
                Ok(_) => Ok(TestConnectionResult {
                    ok: false,
                    error_code: Some("connect_failed".to_owned()),
                }),
                Err(_) => Ok(TestConnectionResult {
                    ok: false,
                    error_code: Some("connect_failed".to_owned()),
                }),
            }
        })
    }

    fn send<'a>(
        &'a self,
        config: &'a SmtpTransportConfig,
        message: &'a SendMessageCommand,
        from_address: &'a str,
    ) -> MailFuture<'a, Result<String, MailServiceError>> {
        Box::pin(async move {
            // Attachments over the webapi need multipart/form-data; slice 1 sends
            // the non-multipart urlencoded shape only.
            if !message.attachments.is_empty() {
                return Err(MailServiceError::Transport {
                    code: "mox_attachments_unsupported",
                });
            }
            let request =
                SendRequest::from_command(message, from_address, config.from_name.as_deref());
            let json =
                serde_json::to_string(&request).map_err(|_| MailServiceError::Transport {
                    code: "build_failed",
                })?;

            let response = self
                .client
                .post(self.send_url())
                .basic_auth(&config.username, Some(config.password.expose_secret()))
                .form(&[("request", json.as_str())])
                .send()
                .await
                .map_err(|_| MailServiceError::Transport {
                    code: "send_failed",
                })?;

            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if !status.is_success() {
                // mox returns 400 with {"Code","Message"} on error; never echo the
                // raw body (it can carry recipient/host detail) — a fixed code only.
                return Err(MailServiceError::Transport {
                    code: "send_rejected",
                });
            }
            let result: SendResult =
                serde_json::from_str(&body).map_err(|_| MailServiceError::Transport {
                    code: "bad_response",
                })?;
            Ok(result.message_id)
        })
    }
}

// ---------------------------------------------------------------------------
// mox webapi wire types (Send)
// ---------------------------------------------------------------------------

/// mox `NameAddress`: an addressee on the wire.
#[derive(Debug, Serialize, Deserialize)]
struct NameAddress {
    #[serde(rename = "Name", default, skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(rename = "Address")]
    address: String,
}

impl NameAddress {
    fn from_domain(addr: &MessageAddress) -> Self {
        Self {
            name: addr.name.clone().unwrap_or_default(),
            address: addr.address.clone(),
        }
    }
}

/// The mox webapi `Send` request (subset used by slice 1). Field names match
/// mox's Go JSON exactly.
#[derive(Debug, Serialize)]
struct SendRequest {
    #[serde(rename = "From", skip_serializing_if = "Option::is_none")]
    from: Option<NameAddress>,
    #[serde(rename = "To")]
    to: Vec<NameAddress>,
    #[serde(rename = "CC", skip_serializing_if = "Vec::is_empty")]
    cc: Vec<NameAddress>,
    #[serde(rename = "BCC", skip_serializing_if = "Vec::is_empty")]
    bcc: Vec<NameAddress>,
    #[serde(rename = "Subject")]
    subject: String,
    #[serde(rename = "Text")]
    text: String,
    #[serde(rename = "References", skip_serializing_if = "Vec::is_empty")]
    references: Vec<String>,
}

impl SendRequest {
    fn from_command(
        command: &SendMessageCommand,
        from_address: &str,
        from_name: Option<&str>,
    ) -> Self {
        // For a reply/forward, thread with In-Reply-To/References. mox accepts a
        // References list; prepend In-Reply-To if it is not already the tail.
        let mut references = command.references.clone();
        if let Some(irt) = &command.in_reply_to
            && !references.iter().any(|r| r == irt)
        {
            references.push(irt.clone());
        }
        Self {
            from: Some(NameAddress {
                name: from_name.unwrap_or_default().to_owned(),
                address: from_address.to_owned(),
            }),
            to: command.to.iter().map(NameAddress::from_domain).collect(),
            cc: command.cc.iter().map(NameAddress::from_domain).collect(),
            bcc: command.bcc.iter().map(NameAddress::from_domain).collect(),
            subject: command.subject.clone(),
            text: command.body_text.clone(),
            references,
        }
    }
}

/// The mox webapi `Send` success response.
#[derive(Debug, Deserialize)]
struct SendResult {
    #[serde(rename = "MessageID")]
    message_id: String,
}

// ---------------------------------------------------------------------------
// mox webhook wire types (Incoming delivery)
// ---------------------------------------------------------------------------

/// mox's `Incoming` webhook payload for an arriving message. Only the fields the
/// read-model ingest needs are decoded; unknown fields are ignored.
#[derive(Debug, Deserialize)]
pub struct Incoming {
    #[serde(rename = "From", default)]
    pub from: Vec<NameAddressPub>,
    #[serde(rename = "To", default)]
    pub to: Vec<NameAddressPub>,
    #[serde(rename = "CC", default)]
    pub cc: Vec<NameAddressPub>,
    #[serde(rename = "Subject", default)]
    pub subject: String,
    #[serde(rename = "MessageID", default)]
    pub message_id: String,
    #[serde(rename = "InReplyTo", default)]
    pub in_reply_to: String,
    #[serde(rename = "References", default)]
    pub references: Vec<String>,
    #[serde(rename = "Text", default)]
    pub text: String,
    #[serde(rename = "HTML", default)]
    pub html: String,
    #[serde(rename = "Meta")]
    pub meta: IncomingMeta,
}

/// The public wire addressee (mirrors [`NameAddress`] but exported for the
/// webhook payload).
#[derive(Debug, Deserialize)]
pub struct NameAddressPub {
    #[serde(rename = "Name", default)]
    pub name: String,
    #[serde(rename = "Address", default)]
    pub address: String,
}

/// mox `IncomingMeta`: storage + SMTP envelope details.
#[derive(Debug, Deserialize)]
pub struct IncomingMeta {
    /// mox's internal per-account message id (stable across webhook redelivery).
    #[serde(rename = "MsgID")]
    pub msg_id: i64,
    /// The SMTP `RCPT TO` — the local recipient this delivery is for.
    #[serde(rename = "RcptTo", default)]
    pub rcpt_to: String,
    /// The destination mailbox name (defaults to `Inbox`).
    #[serde(rename = "MailboxName", default)]
    pub mailbox_name: String,
}

impl Incoming {
    /// The local recipient address this delivery landed for. Prefers the SMTP
    /// envelope `RcptTo`; falls back to the first `To` header address.
    #[must_use]
    pub fn recipient_address(&self) -> Option<String> {
        let rcpt = self.meta.rcpt_to.trim();
        if !rcpt.is_empty() {
            return Some(rcpt.to_owned());
        }
        self.to.first().map(|a| a.address.clone())
    }

    /// The destination mailbox name, defaulting to `Inbox`.
    #[must_use]
    pub fn mailbox_name(&self) -> &str {
        let name = self.meta.mailbox_name.trim();
        if name.is_empty() { "Inbox" } else { name }
    }

    /// Map this delivery into a [`FetchedMessage`] for the inbound store. The
    /// mox `MsgID` becomes the dedupe UID (stable on redelivery); the RFC
    /// `Message-ID` is the secondary idempotency key.
    #[must_use]
    pub fn to_fetched_message(&self) -> FetchedMessage {
        let to = self
            .to
            .iter()
            .filter_map(NameAddressPub::to_domain)
            .collect();
        let cc = self
            .cc
            .iter()
            .filter_map(NameAddressPub::to_domain)
            .collect();
        let from = self.from.first().and_then(NameAddressPub::to_domain);
        let message_id = trim_angle(&self.message_id);
        let in_reply_to = trim_angle(&self.in_reply_to);
        FetchedMessage {
            // ponytail: mox MsgID is i64; the store UID is u32. A single account
            // exceeding ~4.2B lifetime messages would collide — the RFC
            // Message-ID secondary dedupe (below) is the authoritative
            // idempotency key, so a UID collision at most refreshes flags.
            imap_uid: self.meta.msg_id as u32,
            message_id,
            in_reply_to,
            references: self
                .references
                .iter()
                .map(|r| trim_angle(r).unwrap_or_default())
                .filter(|r| !r.is_empty())
                .collect(),
            from,
            to,
            cc,
            subject: self.subject.clone(),
            body_text: (!self.text.is_empty()).then(|| self.text.clone()),
            body_html: (!self.html.is_empty()).then(|| self.html.clone()),
            seen: false,
            flagged: false,
            answered: false,
            draft: false,
            // ponytail: use ingestion time — a webhook fires at delivery, so
            // now() ≈ received. mox's Date header parse (RFC3339 → time) is not
            // worth the serde-format wiring for slice 1.
            received_at: OffsetDateTime::now_utc(),
            attachments: Vec::new(),
        }
    }
}

impl NameAddressPub {
    fn to_domain(&self) -> Option<MessageAddress> {
        MessageAddress::new(self.address.clone())
            .ok()
            .map(|a| a.with_name(Some(self.name.clone())))
    }
}

/// Strip a single enclosing `<>` pair and surrounding whitespace; `None` if the
/// result is empty.
fn trim_angle(raw: &str) -> Option<String> {
    let t = raw
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim();
    (!t.is_empty()).then(|| t.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_comms_application::SendKind;
    use mnt_comms_domain::MailSecurity;
    use mnt_kernel_core::{TraceContext, UserId};

    fn command() -> SendMessageCommand {
        SendMessageCommand {
            actor: UserId::new(),
            kind: SendKind::Reply,
            to: vec![MessageAddress::new("b@localhost").unwrap()],
            cc: vec![],
            bcc: vec![],
            subject: "Re: Quote".to_owned(),
            body_text: "hi ☺".to_owned(),
            attachments: vec![],
            in_reply_to: Some("<orig@localhost>".to_owned()),
            references: vec!["<a@localhost>".to_owned()],
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }
    }

    #[test]
    fn send_request_serializes_to_mox_shape() {
        let req = SendRequest::from_command(&command(), "a@localhost", Some("A"));
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["To"][0]["Address"], "b@localhost");
        assert_eq!(json["Subject"], "Re: Quote");
        assert_eq!(json["Text"], "hi ☺");
        assert_eq!(json["From"]["Address"], "a@localhost");
        // In-Reply-To is folded into References (mox threads on References).
        let refs = json["References"].as_array().unwrap();
        assert!(refs.iter().any(|r| r == "<orig@localhost>"));
        assert!(refs.iter().any(|r| r == "<a@localhost>"));
    }

    #[test]
    fn send_result_parses_message_id() {
        let body = r#"{"MessageID":"<abc@localhost>","Submissions":[{"Address":"b@localhost","QueueMsgID":10}]}"#;
        let r: SendResult = serde_json::from_str(body).unwrap();
        assert_eq!(r.message_id, "<abc@localhost>");
    }

    #[test]
    fn incoming_maps_to_fetched_message() {
        let body = r#"{
            "Version":0,
            "From":[{"Name":"Alice","Address":"a@localhost"}],
            "To":[{"Address":"b@localhost"}],
            "Subject":"Hello",
            "MessageID":"<m1@localhost>",
            "InReplyTo":"<orig@localhost>",
            "References":["<orig@localhost>"],
            "Text":"body here",
            "Meta":{"MsgID":42,"RcptTo":"b@localhost","MailboxName":"Inbox"}
        }"#;
        let inc: Incoming = serde_json::from_str(body).unwrap();
        assert_eq!(inc.recipient_address().as_deref(), Some("b@localhost"));
        assert_eq!(inc.mailbox_name(), "Inbox");
        let fm = inc.to_fetched_message();
        assert_eq!(fm.imap_uid, 42);
        assert_eq!(fm.message_id.as_deref(), Some("m1@localhost"));
        assert_eq!(fm.in_reply_to.as_deref(), Some("orig@localhost"));
        assert_eq!(fm.references, vec!["orig@localhost".to_owned()]);
        assert_eq!(fm.from.unwrap().address, "a@localhost");
        assert_eq!(fm.body_text.as_deref(), Some("body here"));
        assert!(!fm.seen);
    }

    #[test]
    fn incoming_falls_back_to_to_header_when_no_rcpt() {
        let body = r#"{"To":[{"Address":"x@localhost"}],"Subject":"s","MessageID":"<m@l>","Meta":{"MsgID":1}}"#;
        let inc: Incoming = serde_json::from_str(body).unwrap();
        assert_eq!(inc.recipient_address().as_deref(), Some("x@localhost"));
        assert_eq!(inc.mailbox_name(), "Inbox");
    }

    // -----------------------------------------------------------------------
    // test_connection: only a genuine authenticated 2xx counts as `ok`.
    // -----------------------------------------------------------------------

    fn transport_config() -> SmtpTransportConfig {
        SmtpTransportConfig {
            host: "unused".to_owned(),
            port: 0,
            security: MailSecurity::StartTls,
            username: "b".to_owned(),
            password: secrecy::SecretString::from("pw".to_owned()),
            from_address: "b@localhost".to_owned(),
            from_name: None,
        }
    }

    /// Serve exactly one raw HTTP response on an ephemeral localhost port and
    /// return its base URL. No mock-HTTP crate needed: a minimal hand-written
    /// status line is enough for reqwest's client to parse.
    async fn serve_once(status_line: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let response =
                    format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn test_connection_reports_ok_on_authenticated_success() {
        let base_url = serve_once("HTTP/1.1 200 OK").await;
        let sender = MoxWebapiSender::new(base_url);
        let result = sender.test_connection(&transport_config()).await.unwrap();
        assert!(result.ok);
        assert_eq!(result.error_code, None);
    }

    #[tokio::test]
    async fn test_connection_reports_failure_on_wrong_credentials() {
        let base_url = serve_once("HTTP/1.1 401 Unauthorized").await;
        let sender = MoxWebapiSender::new(base_url);
        let result = sender.test_connection(&transport_config()).await.unwrap();
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("auth_failed"));
    }
}
