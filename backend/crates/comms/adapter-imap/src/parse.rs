//! Inbound MIME parsing: a fetched RFC822 byte blob → the application's
//! [`FetchedMessage`].
//!
//! This is the ONLY place `mail-parser` is used. We extract the threading
//! headers (`Message-ID` / `In-Reply-To` / `References`), the addresses, the
//! text + HTML bodies, and the attachment parts (with their decoded bytes). The
//! `seen`/`flagged`/`answered`/`draft` booleans come from the IMAP `FLAGS` the
//! caller passes (not the MIME), and `received_at` falls back from the server
//! `INTERNALDATE` to the `Date:` header.

use mail_parser::{Address, HeaderValue, MessageParser, MimeHeaders};
use mnt_comms_application::{FetchedAttachment, FetchedMessage};
use mnt_comms_domain::MessageAddress;
use time::OffsetDateTime;

/// The IMAP `FLAGS` the caller observed for this message, mapped to booleans.
#[derive(Debug, Clone, Copy, Default)]
pub struct MessageFlags {
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub draft: bool,
}

/// Parse one fetched message body into a [`FetchedMessage`].
///
/// `uid` and `flags` are the IMAP-level facts (the MIME does not carry them);
/// `internal_date` is the server `INTERNALDATE` used as the authoritative receipt
/// time, falling back to the `Date:` header, then to `now`. Returns `None` only
/// if the bytes do not parse as a message at all.
#[must_use]
pub fn parse_message(
    uid: u32,
    flags: MessageFlags,
    internal_date: Option<OffsetDateTime>,
    raw: &[u8],
) -> Option<FetchedMessage> {
    let parsed = MessageParser::default().parse(raw)?;

    let message_id = parsed.message_id().and_then(clean_id);

    let in_reply_to = header_first_id(parsed.in_reply_to());
    let references = header_id_list(parsed.references());

    let from = parsed.from().and_then(first_address);
    let to = address_list(parsed.to());
    let cc = address_list(parsed.cc());

    let subject = parsed.subject().unwrap_or_default().to_owned();
    let body_text = parsed.body_text(0).map(|c| c.into_owned());
    let body_html = parsed.body_html(0).map(|c| c.into_owned());

    let received_at = received_at_from(internal_date, parsed.date());

    let attachments = parsed.attachments().map(part_to_attachment).collect();

    Some(FetchedMessage {
        imap_uid: uid,
        message_id,
        in_reply_to,
        references,
        from,
        to,
        cc,
        subject,
        body_text,
        body_html,
        seen: flags.seen,
        flagged: flags.flagged,
        answered: flags.answered,
        draft: flags.draft,
        received_at,
        attachments,
    })
}

/// Decide the receipt time: prefer the IMAP `INTERNALDATE`, fall back to the
/// `Date:` header, then to the current time.
fn received_at_from(
    internal_date: Option<OffsetDateTime>,
    header_date: Option<&mail_parser::DateTime>,
) -> OffsetDateTime {
    if let Some(d) = internal_date {
        return d;
    }
    if let Some(d) = header_date
        && let Ok(t) = OffsetDateTime::from_unix_timestamp(d.to_timestamp())
    {
        return t;
    }
    OffsetDateTime::now_utc()
}

/// The first message-id token in an In-Reply-To header (one id by convention).
fn header_first_id(value: &HeaderValue<'_>) -> Option<String> {
    if let Some(text) = value.as_text() {
        return clean_id(text);
    }
    value
        .as_text_list()
        .and_then(|list| list.first())
        .and_then(|first| clean_id(first))
}

/// All message-id tokens in a References header, in order (the chain).
fn header_id_list(value: &HeaderValue<'_>) -> Vec<String> {
    if let Some(list) = value.as_text_list() {
        return list.iter().filter_map(|s| clean_id(s)).collect();
    }
    if let Some(text) = value.as_text() {
        // A space-separated single text value: split into individual ids.
        return text.split_whitespace().filter_map(clean_id).collect();
    }
    Vec::new()
}

/// Normalize a message-id token to a canonical, bracket-free form: trim, strip a
/// single pair of surrounding angle brackets (so `<id@h>` and `id@h` compare
/// equal), keep it non-empty, and cap its length so a hostile header cannot bloat
/// a row. `mail-parser` already returns `message_id()` bracket-free; we strip the
/// References/In-Reply-To tokens the same way so threading keys match regardless
/// of which header an id arrived in (and against our outbound ids).
fn clean_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let unbracketed = trimmed
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(trimmed)
        .trim();
    if unbracketed.is_empty() {
        return None;
    }
    Some(unbracketed.chars().take(998).collect())
}

/// The first address in a From header → [`MessageAddress`].
fn first_address(address: &Address<'_>) -> Option<MessageAddress> {
    let addr = address.first()?;
    let email = addr.address()?;
    MessageAddress::new(email)
        .ok()
        .map(|m| m.with_name(addr.name().map(ToOwned::to_owned)))
}

/// Every addressable mailbox in a To/Cc header → [`MessageAddress`] list.
fn address_list(address: Option<&Address<'_>>) -> Vec<MessageAddress> {
    let Some(address) = address else {
        return Vec::new();
    };
    address
        .iter()
        .filter_map(|addr| {
            let email = addr.address()?;
            MessageAddress::new(email)
                .ok()
                .map(|m| m.with_name(addr.name().map(ToOwned::to_owned)))
        })
        .collect()
}

/// One MIME attachment part → [`FetchedAttachment`] (with decoded bytes).
fn part_to_attachment(part: &mail_parser::MessagePart<'_>) -> FetchedAttachment {
    let filename = part
        .attachment_name()
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "attachment".to_owned());
    let content_type = part
        .content_type()
        .map(|ct| match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub),
            None => ct.ctype().to_owned(),
        })
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let content_id = part.content_id().map(str::to_owned);
    // An inline part is one referenced from the HTML body by its Content-ID
    // (e.g. an embedded image) rather than a downloadable attachment.
    let is_inline = content_id.is_some();
    FetchedAttachment {
        filename,
        content_type,
        bytes: part.contents().to_vec(),
        content_id,
        is_inline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] = b"From: Sender <sender@example.com>\r\n\
To: Ops <ops@knl.example>\r\n\
Cc: Manager <mgr@knl.example>\r\n\
Subject: Re: Quote request\r\n\
Message-ID: <reply@example.com>\r\n\
In-Reply-To: <orig@example.com>\r\n\
References: <root@example.com> <orig@example.com>\r\n\
Date: Mon, 23 Jun 2026 10:00:00 +0000\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Here is the body.\r\n";

    #[test]
    fn parses_headers_addresses_and_body() {
        let msg = parse_message(42, MessageFlags::default(), None, SAMPLE).unwrap();
        assert_eq!(msg.imap_uid, 42);
        // Message-ids are canonicalized bracket-free so they compare consistently
        // across Message-ID / In-Reply-To / References (and our outbound ids).
        assert_eq!(msg.message_id.as_deref(), Some("reply@example.com"));
        assert_eq!(msg.in_reply_to.as_deref(), Some("orig@example.com"));
        assert_eq!(
            msg.references,
            vec!["root@example.com".to_owned(), "orig@example.com".to_owned()]
        );
        assert_eq!(msg.from.as_ref().unwrap().address, "sender@example.com");
        assert_eq!(msg.to.len(), 1);
        assert_eq!(msg.to[0].address, "ops@knl.example");
        assert_eq!(msg.cc.len(), 1);
        assert_eq!(msg.subject, "Re: Quote request");
        assert!(msg.body_text.unwrap().contains("Here is the body."));
    }

    #[test]
    fn internal_date_overrides_header_date() {
        let internal = OffsetDateTime::from_unix_timestamp(1_000_000_000).unwrap();
        let msg = parse_message(1, MessageFlags::default(), Some(internal), SAMPLE).unwrap();
        assert_eq!(msg.received_at, internal);
    }

    #[test]
    fn flags_are_carried_from_imap_not_mime() {
        let flags = MessageFlags {
            seen: true,
            flagged: true,
            answered: false,
            draft: false,
        };
        let msg = parse_message(1, flags, None, SAMPLE).unwrap();
        assert!(msg.seen);
        assert!(msg.flagged);
        assert!(!msg.answered);
    }

    #[test]
    fn parses_attachment_part_with_bytes() {
        let raw = b"From: a@b.com\r\n\
To: c@d.com\r\n\
Subject: With file\r\n\
Message-ID: <att@b.com>\r\n\
Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\
\r\n\
--BOUND\r\n\
Content-Type: text/plain\r\n\
\r\n\
see attached\r\n\
--BOUND\r\n\
Content-Type: application/pdf; name=\"quote.pdf\"\r\n\
Content-Disposition: attachment; filename=\"quote.pdf\"\r\n\
\r\n\
%PDF-1.4 fake\r\n\
--BOUND--\r\n";
        let msg = parse_message(2, MessageFlags::default(), None, raw).unwrap();
        assert_eq!(msg.attachments.len(), 1);
        let att = &msg.attachments[0];
        assert_eq!(att.filename, "quote.pdf");
        assert!(att.content_type.starts_with("application/pdf"));
        assert!(!att.bytes.is_empty());
    }

    #[test]
    fn non_message_bytes_return_none_or_empty_safely() {
        // mail-parser is permissive; garbage still yields a (possibly empty)
        // message rather than panicking — assert we don't crash.
        let _ = parse_message(3, MessageFlags::default(), None, b"\x00\x01\x02");
    }
}
