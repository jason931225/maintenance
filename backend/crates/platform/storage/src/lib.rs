//! Evidence object storage.
//!
//! T1.4 owns the S3 port, SeaweedFS-compatible adapter, evidence media rows,
//! and WORM replica verification state used by the work-order completion
//! interlock.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;
use std::time::Duration as StdDuration;

use hmac::{Hmac, KeyInit, Mac};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, EvidenceId, KernelError, OrgId, Timestamp, TraceContext,
    UserId, WorkOrderId,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_workorder_domain::AttachmentStage;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use url::Url;

pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StorageError>> + Send + 'a>>;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),

    #[error("S3 operation failed: {0}")]
    S3(String),

    #[error("presigning failed: {0}")]
    Presign(String),

    #[error("replica verification failed: {0}")]
    Verification(String),
}

impl From<sqlx::Error> for StorageError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

macro_rules! storage_enum {
    (
        $(#[$enum_meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident => $wire:literal
            ),+ $(,)?
        }
    ) => {
        $(#[$enum_meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                $variant,
            )+
        }

        impl $name {
            #[must_use]
            pub const fn as_db_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    other => Err(KernelError::validation(format!(
                        "unknown {} value {other:?}",
                        stringify!($name)
                    ))),
                }
            }
        }
    };
}

storage_enum! {
    pub enum WormReplicaStatus {
        Pending => "PENDING",
        Verified => "VERIFIED",
        Failed => "FAILED",
    }
}

#[derive(Debug, Clone)]
pub struct S3StorageConfig {
    pub endpoint_url: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub primary_bucket: String,
    pub replica_bucket: String,
    pub force_path_style: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresignPutRequest {
    pub bucket: String,
    pub key: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub checksum_sha256: Option<String>,
    pub expires_in: StdDuration,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PresignedUpload {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub expires_in_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutObjectResult {
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyObjectRequest {
    pub source_bucket: String,
    pub source_key: String,
    pub destination_bucket: String,
    pub destination_key: String,
    pub retain_until: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectHead {
    pub size_bytes: i64,
    pub e_tag: Option<String>,
    pub checksum_sha256: Option<String>,
    pub object_lock_mode: Option<String>,
    pub retain_until: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionInfo {
    pub mode: Option<String>,
    pub retain_until: Option<String>,
}

pub trait S3ObjectStore: Send + Sync {
    fn presign_put(&self, request: PresignPutRequest) -> StorageFuture<'_, PresignedUpload>;

    fn copy_object(&self, request: CopyObjectRequest) -> StorageFuture<'_, ()>;

    fn head_object(&self, bucket: String, key: String) -> StorageFuture<'_, ObjectHead>;

    fn get_object_retention(&self, bucket: String, key: String)
    -> StorageFuture<'_, RetentionInfo>;
}

#[derive(Debug, Clone)]
pub struct SeaweedS3Storage {
    client: reqwest::Client,
    endpoint_url: Url,
    region: String,
    access_key_id: String,
    secret_access_key: String,
    force_path_style: bool,
}

impl SeaweedS3Storage {
    /// Build an S3-compatible HTTP client for SeaweedFS path-style buckets.
    pub async fn from_config(config: &S3StorageConfig) -> Result<Self, StorageError> {
        let endpoint_url = Url::parse(&config.endpoint_url)
            .map_err(|err| StorageError::S3(format!("invalid S3 endpoint URL: {err}")))?;
        Ok(Self {
            client: reqwest::Client::new(),
            endpoint_url,
            region: config.region.clone(),
            access_key_id: config.access_key_id.clone(),
            secret_access_key: config.secret_access_key.clone(),
            force_path_style: config.force_path_style,
        })
    }

    #[must_use]
    pub fn from_parts(
        client: reqwest::Client,
        endpoint_url: Url,
        region: String,
        access_key_id: String,
        secret_access_key: String,
        force_path_style: bool,
    ) -> Self {
        Self {
            client,
            endpoint_url,
            region,
            access_key_id,
            secret_access_key,
            force_path_style,
        }
    }

    pub async fn create_bucket(&self, bucket: &str, object_lock: bool) -> Result<(), StorageError> {
        let mut headers = HeaderMap::new();
        if object_lock {
            headers.insert(
                HeaderName::from_static("x-amz-bucket-object-lock-enabled"),
                HeaderValue::from_static("true"),
            );
        }
        let response = self
            .client
            .put(self.bucket_url(bucket)?)
            .headers(headers)
            .send()
            .await
            .map_err(reqwest_error)?;
        if response.status().is_success()
            || response.status().as_u16() == 409
            || response.status().as_u16() == 412
        {
            if object_lock {
                self.enable_bucket_versioning(bucket).await?;
                self.enable_bucket_object_lock(bucket).await?;
            }
            Ok(())
        } else {
            Err(s3_response_error("create bucket", response).await)
        }
    }

    pub async fn put_bytes(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<(), StorageError> {
        self.put_bytes_with_result(bucket, key, content_type, body)
            .await
            .map(|_| ())
    }

    pub async fn put_bytes_with_result(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<PutObjectResult, StorageError> {
        let response = self
            .client
            .put(self.object_url(bucket, key)?)
            .header(CONTENT_TYPE, content_type)
            .body(body)
            .send()
            .await
            .map_err(reqwest_error)?;
        if !response.status().is_success() {
            return Err(s3_response_error("put object", response).await);
        }
        Ok(PutObjectResult {
            version_id: header_string(response.headers(), "x-amz-version-id"),
        })
    }

    pub async fn put_compliance_retention(
        &self,
        bucket: &str,
        key: &str,
        retain_until: Timestamp,
    ) -> Result<(), StorageError> {
        let retain_until = retain_until
            .format(&Rfc3339)
            .map_err(|err| StorageError::S3(format!("invalid retain-until timestamp: {err}")))?;
        let response = self
            .client
            .put(self.object_subresource_url(bucket, key, "retention")?)
            .header(CONTENT_TYPE, "application/xml")
            .body(retention_xml(&retain_until))
            .send()
            .await
            .map_err(reqwest_error)?;
        ensure_success("put object retention", response).await
    }

    pub async fn delete_object(&self, bucket: &str, key: &str) -> Result<(), StorageError> {
        let response = self
            .client
            .delete(self.object_url(bucket, key)?)
            .send()
            .await
            .map_err(reqwest_error)?;
        ensure_success("delete object", response).await
    }

    pub async fn delete_object_version(
        &self,
        bucket: &str,
        key: &str,
        version_id: &str,
    ) -> Result<(), StorageError> {
        let response = self
            .client
            .delete(self.object_version_url(bucket, key, version_id)?)
            .send()
            .await
            .map_err(reqwest_error)?;
        ensure_success("delete object version", response).await
    }

    pub async fn head_object_version(
        &self,
        bucket: &str,
        key: &str,
        version_id: &str,
    ) -> Result<ObjectHead, StorageError> {
        let response = self
            .client
            .head(self.object_version_url(bucket, key, version_id)?)
            .send()
            .await
            .map_err(reqwest_error)?;
        if !response.status().is_success() {
            return Err(s3_response_error("head object version", response).await);
        }
        let headers = response.headers();
        Ok(ObjectHead {
            size_bytes: header_i64(headers, &CONTENT_LENGTH).unwrap_or_default(),
            e_tag: header_string(headers, "etag"),
            checksum_sha256: header_string(headers, "x-amz-checksum-sha256"),
            object_lock_mode: header_string(headers, "x-amz-object-lock-mode"),
            retain_until: header_string(headers, "x-amz-object-lock-retain-until-date"),
        })
    }

    fn presign_put_url(&self, request: PresignPutRequest) -> Result<PresignedUpload, StorageError> {
        let expires_in_secs = request.expires_in.as_secs();
        let mut url = self.object_url(&request.bucket, &request.key)?;
        let host = host_header(&url)?;
        let now = OffsetDateTime::now_utc();
        let date = sigv4_date(now);
        let amz_date = sigv4_timestamp(now);
        let credential_scope = format!("{}/{}/s3/aws4_request", date, self.region);
        let credential = format!("{}/{}", self.access_key_id, credential_scope);

        let mut signed_headers = vec![
            ("content-length".to_owned(), request.size_bytes.to_string()),
            ("content-type".to_owned(), request.content_type.clone()),
            ("host".to_owned(), host),
        ];
        if let Some(checksum) = request.checksum_sha256.as_deref() {
            signed_headers.push(("x-amz-checksum-sha256".to_owned(), checksum.to_owned()));
        }
        signed_headers.sort_by(|left, right| left.0.cmp(&right.0));
        let signed_header_names = signed_headers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(";");

        {
            let mut query = url.query_pairs_mut();
            query.append_pair("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
            query.append_pair("X-Amz-Credential", &credential);
            query.append_pair("X-Amz-Date", &amz_date);
            query.append_pair("X-Amz-Expires", &expires_in_secs.to_string());
            query.append_pair("X-Amz-SignedHeaders", &signed_header_names);
        }

        let canonical_headers = signed_headers
            .iter()
            .map(|(name, value)| format!("{name}:{}\n", value.trim()))
            .collect::<String>();
        let canonical_request = format!(
            "PUT\n{}\n{}\n{}\n{}\nUNSIGNED-PAYLOAD",
            url.path(),
            url.query().unwrap_or_default(),
            canonical_headers,
            signed_header_names
        );
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            credential_scope,
            sha256_hex(canonical_request.as_bytes())
        );
        let signature = sigv4_signature(
            &self.secret_access_key,
            &date,
            &self.region,
            "s3",
            &string_to_sign,
        )?;
        url.query_pairs_mut()
            .append_pair("X-Amz-Signature", &signature);

        let mut headers = vec![
            ("content-length".to_owned(), request.size_bytes.to_string()),
            ("content-type".to_owned(), request.content_type),
        ];
        if let Some(checksum) = request.checksum_sha256 {
            headers.push(("x-amz-checksum-sha256".to_owned(), checksum));
        }
        Ok(PresignedUpload {
            method: "PUT".to_owned(),
            url: url.to_string(),
            headers,
            expires_in_secs,
        })
    }

    fn bucket_url(&self, bucket: &str) -> Result<Url, StorageError> {
        self.path_style_url(bucket, None)
    }

    fn bucket_subresource_url(&self, bucket: &str, subresource: &str) -> Result<Url, StorageError> {
        let mut url = self.bucket_url(bucket)?;
        url.query_pairs_mut().append_pair(subresource, "");
        Ok(url)
    }

    fn object_url(&self, bucket: &str, key: &str) -> Result<Url, StorageError> {
        self.path_style_url(bucket, Some(key))
    }

    fn object_subresource_url(
        &self,
        bucket: &str,
        key: &str,
        subresource: &str,
    ) -> Result<Url, StorageError> {
        let mut url = self.object_url(bucket, key)?;
        url.query_pairs_mut().append_pair(subresource, "");
        Ok(url)
    }

    fn object_version_url(
        &self,
        bucket: &str,
        key: &str,
        version_id: &str,
    ) -> Result<Url, StorageError> {
        let mut url = self.object_url(bucket, key)?;
        url.query_pairs_mut().append_pair("versionId", version_id);
        Ok(url)
    }

    fn path_style_url(&self, bucket: &str, key: Option<&str>) -> Result<Url, StorageError> {
        if !self.force_path_style {
            return Err(StorageError::S3(
                "virtual-hosted S3 URLs are not supported by the SeaweedFS adapter".to_owned(),
            ));
        }
        let mut url = self.endpoint_url.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|()| {
                StorageError::S3("S3 endpoint URL cannot be used as a base".to_owned())
            })?;
            segments.clear();
            segments.push(bucket);
            if let Some(key) = key {
                for segment in key.split('/') {
                    segments.push(segment);
                }
            }
        }
        Ok(url)
    }

    async fn enable_bucket_versioning(&self, bucket: &str) -> Result<(), StorageError> {
        let response = self
            .client
            .put(self.bucket_subresource_url(bucket, "versioning")?)
            .header(CONTENT_TYPE, "application/xml")
            .body("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>")
            .send()
            .await
            .map_err(reqwest_error)?;
        ensure_success("enable bucket versioning", response).await
    }

    async fn enable_bucket_object_lock(&self, bucket: &str) -> Result<(), StorageError> {
        let response = self
            .client
            .put(self.bucket_subresource_url(bucket, "object-lock")?)
            .header(CONTENT_TYPE, "application/xml")
            .body(
                "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>",
            )
            .send()
            .await
            .map_err(reqwest_error)?;
        ensure_success("enable bucket object lock", response).await
    }
}

impl S3ObjectStore for SeaweedS3Storage {
    fn presign_put(&self, request: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        Box::pin(async move { self.presign_put_url(request) })
    }

    fn copy_object(&self, request: CopyObjectRequest) -> StorageFuture<'_, ()> {
        Box::pin(async move {
            let mut headers = HeaderMap::new();
            headers.insert(
                HeaderName::from_static("x-amz-copy-source"),
                header_value(&format!(
                    "/{}/{}",
                    request.source_bucket, request.source_key
                ))?,
            );
            if let Some(retain_until) = request.retain_until {
                headers.insert(
                    HeaderName::from_static("x-amz-object-lock-mode"),
                    HeaderValue::from_static("COMPLIANCE"),
                );
                headers.insert(
                    HeaderName::from_static("x-amz-object-lock-retain-until-date"),
                    header_value(&retain_until.format(&Rfc3339).map_err(|err| {
                        StorageError::S3(format!("invalid retain-until timestamp: {err}"))
                    })?)?,
                );
            }
            let response = self
                .client
                .put(self.object_url(&request.destination_bucket, &request.destination_key)?)
                .headers(headers)
                .send()
                .await
                .map_err(reqwest_error)?;
            ensure_success("copy object", response).await
        })
    }

    fn head_object(&self, bucket: String, key: String) -> StorageFuture<'_, ObjectHead> {
        Box::pin(async move {
            let response = self
                .client
                .head(self.object_url(&bucket, &key)?)
                .send()
                .await
                .map_err(reqwest_error)?;
            if !response.status().is_success() {
                return Err(s3_response_error("head object", response).await);
            }
            let headers = response.headers();
            Ok(ObjectHead {
                size_bytes: header_i64(headers, &CONTENT_LENGTH).unwrap_or_default(),
                e_tag: header_string(headers, "etag"),
                checksum_sha256: header_string(headers, "x-amz-checksum-sha256"),
                object_lock_mode: header_string(headers, "x-amz-object-lock-mode"),
                retain_until: header_string(headers, "x-amz-object-lock-retain-until-date"),
            })
        })
    }

    fn get_object_retention(
        &self,
        bucket: String,
        key: String,
    ) -> StorageFuture<'_, RetentionInfo> {
        Box::pin(async move {
            let response = self
                .client
                .get(self.object_subresource_url(&bucket, &key, "retention")?)
                .send()
                .await
                .map_err(reqwest_error)?;
            if !response.status().is_success() {
                return Err(s3_response_error("get object retention", response).await);
            }
            let body = response.text().await.map_err(reqwest_error)?;
            Ok(RetentionInfo {
                mode: xml_tag_text(&body, "Mode"),
                retain_until: xml_tag_text(&body, "RetainUntilDate"),
            })
        })
    }
}

#[derive(Debug, Clone)]
pub struct EvidenceUploadCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub stage: AttachmentStage,
    pub content_type: String,
    pub size_bytes: i64,
    pub checksum_sha256: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EvidenceMedia {
    pub id: EvidenceId,
    pub work_order_id: WorkOrderId,
    pub stage: AttachmentStage,
    pub s3_key: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub checksum_sha256: Option<String>,
    pub uploaded_by: UserId,
    pub worm_replica_status: WormReplicaStatus,
    pub retry_count: i32,
    pub next_retry_at: Timestamp,
    pub last_error: Option<String>,
    pub verified_at: Option<Timestamp>,
    pub upload_confirmed_at: Option<Timestamp>,
    pub confirmed_by: Option<UserId>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EvidenceUploadTicket {
    pub media: EvidenceMedia,
    pub upload: PresignedUpload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicationConfig {
    pub primary_bucket: String,
    pub replica_bucket: String,
    pub max_retries: i32,
    pub base_retry_delay: Duration,
    pub max_retry_delay: Duration,
    pub retention_period: Duration,
}

impl ReplicationConfig {
    #[must_use]
    pub fn local_test(primary_bucket: String, replica_bucket: String) -> Self {
        Self {
            primary_bucket,
            replica_bucket,
            max_retries: 3,
            base_retry_delay: Duration::seconds(1),
            max_retry_delay: Duration::seconds(30),
            retention_period: Duration::days(1),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicationOutcome {
    pub media_id: EvidenceId,
    pub status: WormReplicaStatus,
    pub retry_count: i32,
}

#[derive(Debug, Clone)]
pub struct EvidenceService<S> {
    pool: PgPool,
    object_store: S,
    primary_bucket: String,
    replica_bucket: String,
    presign_expires_in: StdDuration,
    replication: ReplicationConfig,
}

impl<S> EvidenceService<S>
where
    S: S3ObjectStore,
{
    #[must_use]
    pub fn new(
        pool: PgPool,
        object_store: S,
        primary_bucket: String,
        replica_bucket: String,
    ) -> Self {
        Self {
            pool,
            object_store,
            primary_bucket: primary_bucket.clone(),
            replica_bucket: replica_bucket.clone(),
            presign_expires_in: StdDuration::from_secs(5 * 60),
            replication: ReplicationConfig::local_test(primary_bucket, replica_bucket),
        }
    }

    #[must_use]
    pub fn with_presign_expires_in(mut self, expires_in: StdDuration) -> Self {
        self.presign_expires_in = expires_in;
        self
    }

    #[must_use]
    pub fn with_replication_config(mut self, replication: ReplicationConfig) -> Self {
        self.replication = replication;
        self
    }

    pub async fn issue_presigned_upload(
        &self,
        command: EvidenceUploadCommand,
    ) -> Result<EvidenceUploadTicket, StorageError> {
        validate_upload_command(&command)?;
        let branch_id = branch_for_work_order(&self.pool, command.work_order_id).await?;
        let media_id = EvidenceId::new();
        let s3_key = evidence_s3_key(command.work_order_id, command.stage, media_id);
        let upload = self
            .object_store
            .presign_put(PresignPutRequest {
                bucket: self.primary_bucket.clone(),
                key: s3_key.clone(),
                content_type: command.content_type.clone(),
                size_bytes: command.size_bytes,
                checksum_sha256: command.checksum_sha256.clone(),
                expires_in: self.presign_expires_in,
            })
            .await?;
        let event = evidence_audit_event(
            "evidence.upload",
            Some(command.actor),
            branch_id,
            media_id,
            command.trace,
            command.occurred_at,
        )?;
        let media = with_audit::<_, EvidenceMedia, StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // FIX 3: lock the parent work-order row and reject AFTER/REPORT
                // completion evidence once the work order is terminal, so the
                // WORM completion invariant cannot be invalidated post-closure.
                ensure_work_order_accepts_evidence_tx(tx, command.work_order_id, command.stage)
                    .await?;
                insert_evidence_media_tx(
                    tx,
                    NewEvidenceMedia {
                        media_id,
                        work_order_id: command.work_order_id,
                        stage: command.stage,
                        s3_key: &s3_key,
                        content_type: &command.content_type,
                        size_bytes: command.size_bytes,
                        checksum_sha256: command.checksum_sha256.as_deref(),
                        uploaded_by: command.actor,
                        occurred_at: command.occurred_at,
                    },
                )
                .await
            })
        })
        .await?;
        Ok(EvidenceUploadTicket { media, upload })
    }

    pub async fn evidence_media(
        &self,
        media_id: EvidenceId,
    ) -> Result<EvidenceMedia, StorageError> {
        evidence_media_by_id(&self.pool, media_id).await
    }

    pub async fn confirm_upload(
        &self,
        media_id: EvidenceId,
        actor: UserId,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Result<EvidenceMedia, StorageError> {
        let media = evidence_media_by_id(&self.pool, media_id).await?;
        let branch_id = branch_for_work_order(&self.pool, media.work_order_id).await?;
        let event = evidence_audit_event(
            "evidence.confirm",
            Some(actor),
            branch_id,
            media_id,
            trace,
            occurred_at,
        )?;
        with_audit::<_, EvidenceMedia, StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    UPDATE evidence_media
                    SET upload_confirmed_at = COALESCE(upload_confirmed_at, $2),
                        confirmed_by = COALESCE(confirmed_by, $3),
                        updated_at = $2
                    WHERE id = $1
                    "#,
                )
                .bind(*media_id.as_uuid())
                .bind(occurred_at)
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                evidence_media_by_id_tx(tx, media_id).await
            })
        })
        .await
    }

    pub async fn replicate_once(
        &self,
        media_id: EvidenceId,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Result<ReplicationOutcome, StorageError> {
        let media = evidence_media_by_id(&self.pool, media_id).await?;
        if media.worm_replica_status == WormReplicaStatus::Verified {
            return Ok(ReplicationOutcome {
                media_id,
                status: WormReplicaStatus::Verified,
                retry_count: media.retry_count,
            });
        }

        let result = self
            .copy_and_verify_replica(&media, occurred_at)
            .await
            .map(|()| WormReplicaStatus::Verified);
        match result {
            Ok(status) => self
                .record_replication_success(media, trace, occurred_at)
                .await
                .map(|media| ReplicationOutcome {
                    media_id,
                    status,
                    retry_count: media.retry_count,
                }),
            Err(err) => {
                let message = err.to_string();
                tracing::error!(
                    media_id = %media_id,
                    work_order_id = %media.work_order_id,
                    retry_count = media.retry_count + 1,
                    error = %message,
                    "evidence WORM replication attempt failed"
                );
                self.record_replication_failure(media, message, trace, occurred_at)
                    .await
            }
        }
    }

    async fn copy_and_verify_replica(
        &self,
        media: &EvidenceMedia,
        now: Timestamp,
    ) -> Result<(), StorageError> {
        self.object_store
            .copy_object(CopyObjectRequest {
                source_bucket: self.primary_bucket.clone(),
                source_key: media.s3_key.clone(),
                destination_bucket: self.replica_bucket.clone(),
                destination_key: media.s3_key.clone(),
                retain_until: Some(now + self.replication.retention_period),
            })
            .await?;
        let head = self
            .object_store
            .head_object(self.replica_bucket.clone(), media.s3_key.clone())
            .await?;
        if head.size_bytes != media.size_bytes {
            return Err(StorageError::Verification(format!(
                "replica size mismatch: expected {}, got {}",
                media.size_bytes, head.size_bytes
            )));
        }
        if let (Some(expected), Some(actual)) = (
            media.checksum_sha256.as_deref(),
            head.checksum_sha256.as_deref(),
        ) && expected != actual
        {
            return Err(StorageError::Verification(
                "replica checksum_sha256 mismatch".to_owned(),
            ));
        }
        let retention = self
            .object_store
            .get_object_retention(self.replica_bucket.clone(), media.s3_key.clone())
            .await?;
        let retention_mode = retention.mode.or(head.object_lock_mode);
        if retention_mode.as_deref() != Some("COMPLIANCE") {
            return Err(StorageError::Verification(
                "replica object is not under COMPLIANCE retention".to_owned(),
            ));
        }
        let retain_until = retention.retain_until.or(head.retain_until);
        if retain_until.is_none() {
            return Err(StorageError::Verification(
                "replica object has no retain-until timestamp".to_owned(),
            ));
        }
        let _ = now;
        Ok(())
    }

    async fn record_replication_success(
        &self,
        media: EvidenceMedia,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Result<EvidenceMedia, StorageError> {
        let branch_id = branch_for_work_order(&self.pool, media.work_order_id).await?;
        let event = evidence_audit_event(
            "evidence.verify",
            None,
            branch_id,
            media.id,
            trace,
            occurred_at,
        )?;
        with_audit::<_, EvidenceMedia, StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    UPDATE evidence_media
                    SET worm_replica_status = 'VERIFIED',
                        verified_at = $2,
                        last_error = NULL,
                        next_retry_at = $2,
                        updated_at = $2
                    WHERE id = $1
                    "#,
                )
                .bind(*media.id.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                evidence_media_by_id_tx(tx, media.id).await
            })
        })
        .await
    }

    async fn record_replication_failure(
        &self,
        media: EvidenceMedia,
        error: String,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Result<ReplicationOutcome, StorageError> {
        let branch_id = branch_for_work_order(&self.pool, media.work_order_id).await?;
        let next_retry_count = media.retry_count + 1;
        let next_status = if next_retry_count >= self.replication.max_retries {
            WormReplicaStatus::Failed
        } else {
            WormReplicaStatus::Pending
        };
        let next_retry_at = if next_status == WormReplicaStatus::Failed {
            occurred_at
        } else {
            occurred_at + retry_delay(next_retry_count, &self.replication)
        };
        if next_status == WormReplicaStatus::Failed {
            tracing::error!(
                media_id = %media.id,
                work_order_id = %media.work_order_id,
                retry_count = next_retry_count,
                "evidence WORM replication reached max retries and is visible in admin queue"
            );
        }
        let event = evidence_audit_event(
            "evidence.verify",
            None,
            branch_id,
            media.id,
            trace,
            occurred_at,
        )?;
        with_audit::<_, (), StorageError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    UPDATE evidence_media
                    SET worm_replica_status = $2,
                        retry_count = $3,
                        next_retry_at = $4,
                        last_error = $5,
                        updated_at = $6
                    WHERE id = $1
                    "#,
                )
                .bind(*media.id.as_uuid())
                .bind(next_status.as_db_str())
                .bind(next_retry_count)
                .bind(next_retry_at)
                .bind(error)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await?;
        Ok(ReplicationOutcome {
            media_id: media.id,
            status: next_status,
            retry_count: next_retry_count,
        })
    }
}

pub fn evidence_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: BranchId,
    media_id: EvidenceId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "evidence_media",
        media_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}

#[must_use]
pub fn evidence_s3_key(
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
    media_id: EvidenceId,
) -> String {
    format!(
        "work-orders/{}/{}/{}",
        work_order_id,
        stage.as_db_str(),
        media_id
    )
}

/// Maximum evidence object size accepted for presign (50 MiB). Caps the
/// authz-gated storage-exhaustion / cost-amplification vector: a presign for a
/// larger object is rejected before any URL is issued.
pub const MAX_EVIDENCE_SIZE_BYTES: i64 = 50 * 1024 * 1024;

/// Content types accepted for evidence uploads. Matched case-insensitively
/// against the media type (parameters after `;` are ignored). Anything outside
/// this set — e.g. `text/html`, `image/svg+xml` — is rejected before presign so
/// an arbitrary content-type can never be stored.
pub const ALLOWED_EVIDENCE_CONTENT_TYPES: [&str; 4] =
    ["image/jpeg", "image/png", "image/heic", "application/pdf"];

fn validate_upload_command(command: &EvidenceUploadCommand) -> Result<(), StorageError> {
    let content_type = command.content_type.trim();
    if content_type.is_empty() {
        return Err(KernelError::validation("evidence content_type is required").into());
    }
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    if !ALLOWED_EVIDENCE_CONTENT_TYPES.contains(&media_type.as_str()) {
        return Err(KernelError::validation(format!(
            "evidence content_type {:?} is not allowed (permitted: {})",
            command.content_type,
            ALLOWED_EVIDENCE_CONTENT_TYPES.join(", ")
        ))
        .into());
    }
    if command.size_bytes < 0 {
        return Err(KernelError::validation("evidence size must be non-negative").into());
    }
    if command.size_bytes > MAX_EVIDENCE_SIZE_BYTES {
        return Err(KernelError::validation(format!(
            "evidence size {} exceeds the maximum of {} bytes",
            command.size_bytes, MAX_EVIDENCE_SIZE_BYTES
        ))
        .into());
    }
    Ok(())
}

fn retry_delay(retry_count: i32, config: &ReplicationConfig) -> Duration {
    let exponent = u32::try_from(retry_count.saturating_sub(1)).unwrap_or(0);
    let multiplier = 2_i32.saturating_pow(exponent);
    let delay = config.base_retry_delay * multiplier;
    if delay > config.max_retry_delay {
        config.max_retry_delay
    } else {
        delay
    }
}

async fn branch_for_work_order(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<BranchId, StorageError> {
    let branch_uuid: uuid::Uuid =
        sqlx::query_scalar("SELECT branch_id FROM work_orders WHERE id = $1")
            .bind(*work_order_id.as_uuid())
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    Ok(BranchId::from_uuid(branch_uuid))
}

struct NewEvidenceMedia<'a> {
    media_id: EvidenceId,
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
    s3_key: &'a str,
    content_type: &'a str,
    size_bytes: i64,
    checksum_sha256: Option<&'a str>,
    uploaded_by: UserId,
    occurred_at: Timestamp,
}

/// FIX 3: lock the parent work-order row and reject AFTER/REPORT completion
/// evidence when the work order has reached a terminal status. Only the two
/// completion stages feed the `evidence_verified` interlock, so other stages
/// (REQUEST/BEFORE/DURING/OUTSOURCE_RESULT) are left insertable.
async fn ensure_work_order_accepts_evidence_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
) -> Result<(), StorageError> {
    if !matches!(stage, AttachmentStage::After | AttachmentStage::Report) {
        return Ok(());
    }
    let status: String =
        sqlx::query_scalar("SELECT status FROM work_orders WHERE id = $1 FOR UPDATE")
            .bind(*work_order_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    if matches!(
        status.as_str(),
        "FINAL_COMPLETED" | "ARCHIVED" | "CANCELLED"
    ) {
        return Err(KernelError::conflict(format!(
            "cannot attach {} evidence to a work order in terminal status {status}",
            stage.as_db_str()
        ))
        .into());
    }
    Ok(())
}

async fn insert_evidence_media_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    media: NewEvidenceMedia<'_>,
) -> Result<EvidenceMedia, StorageError> {
    sqlx::query(
        r#"
        INSERT INTO evidence_media (
            id, work_order_id, stage, s3_key, content_type, size_bytes,
            checksum_sha256, uploaded_by, worm_replica_status,
            retry_count, next_retry_at, created_at, updated_at, org_id
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, 'PENDING',
            0, $9, $9, $9, $10
        )
        "#,
    )
    .bind(*media.media_id.as_uuid())
    .bind(*media.work_order_id.as_uuid())
    .bind(media.stage.as_db_str())
    .bind(media.s3_key)
    .bind(media.content_type.trim())
    .bind(media.size_bytes)
    .bind(media.checksum_sha256)
    .bind(*media.uploaded_by.as_uuid())
    .bind(media.occurred_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(tx.as_mut())
    .await?;
    evidence_media_by_id_tx(tx, media.media_id).await
}

async fn evidence_media_by_id(
    pool: &PgPool,
    id: EvidenceId,
) -> Result<EvidenceMedia, StorageError> {
    let row = sqlx::query(
        r#"
        SELECT id, work_order_id, stage, s3_key, content_type, size_bytes,
               checksum_sha256, uploaded_by, worm_replica_status, retry_count,
               next_retry_at, last_error, verified_at, upload_confirmed_at,
               confirmed_by, created_at, updated_at
        FROM evidence_media
        WHERE id = $1
        "#,
    )
    .bind(*id.as_uuid())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| KernelError::not_found("evidence media was not found"))?;
    evidence_media_from_row(&row)
}

async fn evidence_media_by_id_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: EvidenceId,
) -> Result<EvidenceMedia, StorageError> {
    let row = sqlx::query(
        r#"
        SELECT id, work_order_id, stage, s3_key, content_type, size_bytes,
               checksum_sha256, uploaded_by, worm_replica_status, retry_count,
               next_retry_at, last_error, verified_at, upload_confirmed_at,
               confirmed_by, created_at, updated_at
        FROM evidence_media
        WHERE id = $1
        "#,
    )
    .bind(*id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("evidence media was not found"))?;
    evidence_media_from_row(&row)
}

fn evidence_media_from_row(row: &sqlx::postgres::PgRow) -> Result<EvidenceMedia, StorageError> {
    let stage: String = row.try_get("stage")?;
    let status: String = row.try_get("worm_replica_status")?;
    Ok(EvidenceMedia {
        id: EvidenceId::from_uuid(row.try_get("id")?),
        work_order_id: WorkOrderId::from_uuid(row.try_get("work_order_id")?),
        stage: AttachmentStage::from_db_str(&stage)?,
        s3_key: row.try_get("s3_key")?,
        content_type: row.try_get("content_type")?,
        size_bytes: row.try_get("size_bytes")?,
        checksum_sha256: row.try_get("checksum_sha256")?,
        uploaded_by: UserId::from_uuid(row.try_get("uploaded_by")?),
        worm_replica_status: WormReplicaStatus::from_db_str(&status)?,
        retry_count: row.try_get("retry_count")?,
        next_retry_at: row.try_get("next_retry_at")?,
        last_error: row.try_get("last_error")?,
        verified_at: row.try_get("verified_at")?,
        upload_confirmed_at: row.try_get("upload_confirmed_at")?,
        confirmed_by: row
            .try_get::<Option<uuid::Uuid>, _>("confirmed_by")?
            .map(UserId::from_uuid),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn ensure_success(operation: &str, response: reqwest::Response) -> Result<(), StorageError> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(s3_response_error(operation, response).await)
    }
}

async fn s3_response_error(operation: &str, response: reqwest::Response) -> StorageError {
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|err| format!("<failed to read body: {err}>"));
    StorageError::S3(format!("{operation} failed with {status}: {body}"))
}

fn reqwest_error(value: reqwest::Error) -> StorageError {
    StorageError::S3(value.to_string())
}

fn header_value(value: &str) -> Result<HeaderValue, StorageError> {
    HeaderValue::from_str(value)
        .map_err(|err| StorageError::S3(format!("invalid S3 header value: {err}")))
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn header_i64(headers: &HeaderMap, name: &HeaderName) -> Option<i64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
}

fn host_header(url: &Url) -> Result<String, StorageError> {
    let host = url
        .host_str()
        .ok_or_else(|| StorageError::S3("S3 URL has no host".to_owned()))?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn retention_xml(retain_until: &str) -> String {
    format!(
        "<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>{retain_until}</RetainUntilDate></Retention>"
    )
}

fn xml_tag_text(body: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let start = body.find(&start_tag)? + start_tag.len();
    let end = body[start..].find(&end_tag)? + start;
    Some(body[start..end].to_owned())
}

fn sigv4_date(now: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

fn sigv4_timestamp(now: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], value: &str) -> Result<Vec<u8>, StorageError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|err| StorageError::Presign(format!("invalid HMAC key: {err}")))?;
    mac.update(value.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn sigv4_signature(
    secret_access_key: &str,
    date: &str,
    region: &str,
    service: &str,
    string_to_sign: &str,
) -> Result<String, StorageError> {
    let k_date = hmac_sha256(format!("AWS4{secret_access_key}").as_bytes(), date)?;
    let k_region = hmac_sha256(&k_date, region)?;
    let k_service = hmac_sha256(&k_region, service)?;
    let k_signing = hmac_sha256(&k_service, "aws4_request")?;
    Ok(hex::encode(hmac_sha256(&k_signing, string_to_sign)?))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use mnt_workorder_domain::PriorityLevel;
    use sqlx::PgPool;
    use time::OffsetDateTime;

    use super::*;

    #[derive(Debug, Clone)]
    struct StaticObjectStore {
        copy_errors: Arc<Mutex<Vec<String>>>,
    }

    impl StaticObjectStore {
        fn ok() -> Self {
            Self {
                copy_errors: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn fail_copy(errors: Vec<&str>) -> Self {
            Self {
                copy_errors: Arc::new(Mutex::new(
                    errors.into_iter().map(ToOwned::to_owned).collect(),
                )),
            }
        }
    }

    impl S3ObjectStore for StaticObjectStore {
        fn presign_put(&self, request: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
            Box::pin(async move {
                Ok(PresignedUpload {
                    method: "PUT".to_owned(),
                    url: format!("http://storage.local/{}/{}", request.bucket, request.key),
                    headers: vec![("content-type".to_owned(), request.content_type)],
                    expires_in_secs: request.expires_in.as_secs(),
                })
            })
        }

        fn copy_object(&self, _request: CopyObjectRequest) -> StorageFuture<'_, ()> {
            Box::pin(async move {
                let mut errors = self.copy_errors.lock().unwrap();
                if errors.is_empty() {
                    Ok(())
                } else {
                    Err(StorageError::S3(errors.remove(0)))
                }
            })
        }

        fn head_object(&self, _bucket: String, _key: String) -> StorageFuture<'_, ObjectHead> {
            Box::pin(async {
                Ok(ObjectHead {
                    size_bytes: 1024,
                    e_tag: Some("\"etag\"".to_owned()),
                    checksum_sha256: None,
                    object_lock_mode: Some("COMPLIANCE".to_owned()),
                    retain_until: Some("2026-06-13T00:00:00Z".to_owned()),
                })
            })
        }

        fn get_object_retention(
            &self,
            _bucket: String,
            _key: String,
        ) -> StorageFuture<'_, RetentionInfo> {
            Box::pin(async {
                Ok(RetentionInfo {
                    mode: Some("COMPLIANCE".to_owned()),
                    retain_until: Some("2026-06-13T00:00:00Z".to_owned()),
                })
            })
        }
    }

    #[sqlx::test(migrations = "../db/migrations")]
    async fn presign_flow_records_pending_evidence_and_upload_audit(pool: PgPool) {
        let seeded = seed_work_order(&pool).await;
        let service = EvidenceService::new(
            pool.clone(),
            StaticObjectStore::ok(),
            "primary".to_owned(),
            "replica".to_owned(),
        );

        let ticket = service
            .issue_presigned_upload(EvidenceUploadCommand {
                actor: seeded.uploaded_by,
                work_order_id: seeded.work_order_id,
                stage: AttachmentStage::After,
                content_type: "image/jpeg".to_owned(),
                size_bytes: 1024,
                checksum_sha256: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        assert_eq!(ticket.upload.method, "PUT");
        assert_eq!(ticket.media.stage, AttachmentStage::After);
        assert_eq!(ticket.media.worm_replica_status, WormReplicaStatus::Pending);
        assert!(
            ticket
                .media
                .s3_key
                .contains(&seeded.work_order_id.to_string())
        );

        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'evidence.upload'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit_count, 1);
    }

    #[sqlx::test(migrations = "../db/migrations")]
    async fn failed_after_max_retries_is_visible_in_admin_queue(pool: PgPool) {
        let seeded = seed_work_order(&pool).await;
        let service = EvidenceService::new(
            pool.clone(),
            StaticObjectStore::fail_copy(vec!["source missing", "still missing"]),
            "primary".to_owned(),
            "replica".to_owned(),
        )
        .with_replication_config(ReplicationConfig {
            primary_bucket: "primary".to_owned(),
            replica_bucket: "replica".to_owned(),
            max_retries: 2,
            base_retry_delay: Duration::seconds(1),
            max_retry_delay: Duration::seconds(5),
            retention_period: Duration::days(1),
        });
        let ticket = service
            .issue_presigned_upload(EvidenceUploadCommand {
                actor: seeded.uploaded_by,
                work_order_id: seeded.work_order_id,
                stage: AttachmentStage::Report,
                content_type: "image/jpeg".to_owned(),
                size_bytes: 1024,
                checksum_sha256: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        let first = service
            .replicate_once(
                ticket.media.id,
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .await
            .unwrap();
        assert_eq!(first.status, WormReplicaStatus::Pending);
        assert_eq!(first.retry_count, 1);

        let second = service
            .replicate_once(
                ticket.media.id,
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .await
            .unwrap();
        assert_eq!(second.status, WormReplicaStatus::Failed);
        assert_eq!(second.retry_count, 2);

        let queued: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM unverified_evidence_admin_queue WHERE id = $1",
        )
        .bind(*ticket.media.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(queued, 1);
    }

    // FIX 3 (storage layer): AFTER/REPORT evidence must be rejected for a work
    // order in a terminal status — the WORM completion invariant cannot be
    // invalidated after FINAL_COMPLETED.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn presign_rejected_for_after_evidence_on_terminal_work_order(pool: PgPool) {
        let seeded = seed_work_order_with_status(&pool, "FINAL_COMPLETED").await;
        let service = EvidenceService::new(
            pool.clone(),
            StaticObjectStore::ok(),
            "primary".to_owned(),
            "replica".to_owned(),
        );

        let err = service
            .issue_presigned_upload(EvidenceUploadCommand {
                actor: seeded.uploaded_by,
                work_order_id: seeded.work_order_id,
                stage: AttachmentStage::After,
                content_type: "image/jpeg".to_owned(),
                size_bytes: 1024,
                checksum_sha256: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("terminal"),
            "expected terminal-status rejection, got: {err}"
        );

        // No evidence row and no audit row should have been written.
        let media_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM evidence_media WHERE work_order_id = $1")
                .bind(*seeded.work_order_id.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(media_count, 0);
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'evidence.upload'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit_count, 0);
    }

    // FIX 3 (DB trigger layer): a direct INSERT of AFTER/REPORT evidence on a
    // terminal work order must be rejected by the migration-0019 trigger even
    // when the REST/storage guard is bypassed.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn db_trigger_rejects_after_evidence_insert_on_terminal_work_order(pool: PgPool) {
        let seeded = seed_work_order_with_status(&pool, "ARCHIVED").await;
        let result = sqlx::query(
            r#"
            INSERT INTO evidence_media (
                work_order_id, stage, s3_key, content_type, size_bytes,
                uploaded_by, worm_replica_status, retry_count, org_id
            )
            VALUES ($1, 'REPORT', $2, 'image/jpeg', 1024, $3, 'PENDING', 0, $4)
            "#,
        )
        .bind(*seeded.work_order_id.as_uuid())
        .bind(format!(
            "work-orders/{}/REPORT/direct",
            seeded.work_order_id
        ))
        .bind(*seeded.uploaded_by.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(&pool)
        .await;
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("terminal"),
            "expected DB trigger terminal rejection, got: {err}"
        );

        // A non-completion stage (BEFORE) remains insertable on a terminal WO.
        sqlx::query(
            r#"
            INSERT INTO evidence_media (
                work_order_id, stage, s3_key, content_type, size_bytes,
                uploaded_by, worm_replica_status, retry_count, org_id
            )
            VALUES ($1, 'BEFORE', $2, 'image/jpeg', 1024, $3, 'PENDING', 0, $4)
            "#,
        )
        .bind(*seeded.work_order_id.as_uuid())
        .bind(format!(
            "work-orders/{}/BEFORE/direct",
            seeded.work_order_id
        ))
        .bind(*seeded.uploaded_by.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    }

    #[test]
    fn retry_delay_is_bounded_exponential() {
        let config = ReplicationConfig {
            primary_bucket: "primary".to_owned(),
            replica_bucket: "replica".to_owned(),
            max_retries: 5,
            base_retry_delay: Duration::seconds(2),
            max_retry_delay: Duration::seconds(5),
            retention_period: Duration::days(1),
        };
        assert_eq!(retry_delay(1, &config), Duration::seconds(2));
        assert_eq!(retry_delay(2, &config), Duration::seconds(4));
        assert_eq!(retry_delay(3, &config), Duration::seconds(5));
    }

    #[derive(Debug, Clone, Copy)]
    struct SeededEvidenceContext {
        work_order_id: WorkOrderId,
        uploaded_by: UserId,
    }

    async fn seed_work_order(pool: &PgPool) -> SeededEvidenceContext {
        seed_work_order_with_status(pool, "REPORT_SUBMITTED").await
    }

    async fn seed_work_order_with_status(pool: &PgPool, status: &str) -> SeededEvidenceContext {
        let branch_id = seed_branch(pool).await;
        let uploaded_by = seed_user(pool, "Evidence Uploader", "MECHANIC", branch_id).await;
        let requested_by = seed_user(pool, "Reception", "RECEPTIONIST", branch_id).await;
        let equipment_id = seed_equipment(pool, branch_id).await;
        let work_order_id = WorkOrderId::new();
        sqlx::query(
            r#"
            INSERT INTO work_orders (
                id, request_no, branch_id, equipment_id, customer_id, site_id,
                requested_by, status, priority, symptom, result_type, org_id
            )
            SELECT $1, $6, $2, e.id, e.customer_id, e.site_id,
                   $3, $7, $4, 'Evidence fixture', 'COMPLETED', $8
            FROM registry_equipment e
            WHERE e.id = $5
            "#,
        )
        .bind(*work_order_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*requested_by.as_uuid())
        .bind(PriorityLevel::Unset.as_db_str())
        .bind(equipment_id)
        .bind(format!(
            "20260612-{:03}",
            (work_order_id.as_uuid().as_u128() % 1000) as u16
        ))
        .bind(status)
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
        SeededEvidenceContext {
            work_order_id,
            uploaded_by,
        }
    }

    async fn seed_branch(pool: &PgPool) -> BranchId {
        let region_id: uuid::Uuid =
            sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
                .bind(format!("Region {}", uuid::Uuid::new_v4()))
                .bind(*OrgId::knl().as_uuid())
                .fetch_one(pool)
                .await
                .unwrap();
        let branch_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(region_id)
        .bind("HQ Storage Test")
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
        BranchId::from_uuid(branch_id)
    }

    async fn seed_user(pool: &PgPool, name: &str, role: &str, branch_id: BranchId) -> UserId {
        let user_id = UserId::new();
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
            .bind(*user_id.as_uuid())
            .bind(name)
            .bind(Vec::from([role]))
            .bind(*OrgId::knl().as_uuid())
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(*user_id.as_uuid())
            .bind(*branch_id.as_uuid())
            .bind(*OrgId::knl().as_uuid())
            .execute(pool)
            .await
            .unwrap();
        user_id
    }

    async fn seed_equipment(pool: &PgPool, branch_id: BranchId) -> uuid::Uuid {
        let customer_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(*branch_id.as_uuid())
        .bind("Customer Storage")
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
        let site_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(*branch_id.as_uuid())
        .bind(customer_id)
        .bind("Site Storage")
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query_scalar(
            r#"
            INSERT INTO registry_equipment (
                branch_id, customer_id, site_id, equipment_no, management_no,
                manufacturer_code, kind_code, power_code, status,
                specification, ton_text, model, source_sheet, source_row, org_id
            )
            VALUES ($1, $2, $3, 'STR12-0001', 'S1',
                    'S', 'T', 'R', '임대', '좌식', '2.5', 'STORAGE', 'test', 1, $4)
            RETURNING id
            "#,
        )
        .bind(*branch_id.as_uuid())
        .bind(customer_id)
        .bind(site_id)
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn upload_command(content_type: &str, size_bytes: i64) -> EvidenceUploadCommand {
        EvidenceUploadCommand {
            actor: UserId::new(),
            work_order_id: WorkOrderId::new(),
            stage: AttachmentStage::After,
            content_type: content_type.to_owned(),
            size_bytes,
            checksum_sha256: None,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }
    }

    #[test]
    fn validate_upload_accepts_allowed_types_and_parameters() {
        for content_type in ["image/jpeg", "image/png", "image/heic", "application/pdf"] {
            validate_upload_command(&upload_command(content_type, 1024)).unwrap();
        }
        // Parameters and casing are tolerated on the media type.
        validate_upload_command(&upload_command("image/JPEG; charset=binary", 1024)).unwrap();
        // Exactly at the limit is allowed.
        validate_upload_command(&upload_command("image/png", MAX_EVIDENCE_SIZE_BYTES)).unwrap();
    }

    #[test]
    fn validate_upload_rejects_disallowed_content_type() {
        for content_type in ["text/html", "image/svg+xml", "application/octet-stream"] {
            let err = validate_upload_command(&upload_command(content_type, 1024)).unwrap_err();
            match err {
                StorageError::Domain(kernel) => {
                    assert_eq!(kernel.kind, mnt_kernel_core::ErrorKind::Validation);
                }
                other => panic!("expected validation error, got {other:?}"),
            }
        }
    }

    #[test]
    fn validate_upload_rejects_oversize() {
        let err =
            validate_upload_command(&upload_command("image/jpeg", MAX_EVIDENCE_SIZE_BYTES + 1))
                .unwrap_err();
        match err {
            StorageError::Domain(kernel) => {
                assert_eq!(kernel.kind, mnt_kernel_core::ErrorKind::Validation);
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }
}
