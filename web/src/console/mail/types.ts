import type {
  MailAttachmentView,
  MailFolderView,
  MailMessageView,
  MailThreadDetail,
  MailThreadView,
} from "../../api/types";

export type MailClassification = "normal" | "confidential" | "sensitive" | "quarantine";
export type MailAuthResult = "pass" | "fail" | "neutral" | "unknown";
export type MailTlsResult = "verified" | "opportunistic" | "none" | "unknown";
export type MailStorageEncryption = "encrypted" | "unknown";
export type MailPbacDecision = "allowed" | "omitted" | "step_up_required";

export interface MailObjectRef {
  code: string;
  kind?: string;
  id?: string;
  href?: string;
}

export interface MailSenderAuth {
  spf?: MailAuthResult;
  dkim?: MailAuthResult;
  dmarc?: MailAuthResult;
  tls?: MailTlsResult;
  storage_encryption?: MailStorageEncryption;
}

export interface MailGovernance {
  classification?: MailClassification;
  retention_label?: string;
  retention_until?: string | null;
  retention_state?: string | null;
  litigation_hold?: boolean;
  pbac_decision?: MailPbacDecision;
  object_refs?: MailObjectRef[];
  sender_auth?: MailSenderAuth;
}

export type ConsoleMailFolder = MailFolderView;

export type ConsoleMailThread = MailThreadView & {
  governance?: MailGovernance;
  sender_auth?: MailSenderAuth;
  spam?: boolean;
};

export type ConsoleMailAttachment = MailAttachmentView & {
  ingest_job_id?: string;
  ingest_code?: string;
  evidence_record_id?: string;
  evidence_code?: string;
  lifecycle_status?: string;
  governance?: MailGovernance;
};

export type ConsoleMailMessage = Omit<MailMessageView, "attachments"> & {
  attachments: ConsoleMailAttachment[];
  governance?: MailGovernance;
  sender_auth?: MailSenderAuth;
};

export type ConsoleMailThreadDetail = Omit<MailThreadDetail, "messages"> & {
  messages: ConsoleMailMessage[];
  governance?: MailGovernance;
};

export type MailComposerMode = "new" | "reply" | "forward";

export interface MailComposerState {
  mode: MailComposerMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references: string[];
  classification: MailClassification;
}

export type MailEgressReason =
  | "externalRecipient"
  | "unapprovedAttachment"
  | "sensitiveClassification"
  | "litigationHold"
  | "retentionLock"
  | "policyDenied";

export interface MailEgressBlock {
  reasons: MailEgressReason[];
  nextAction: "openLifecycle" | "removeAttachment" | "requestApproval" | "notifyCompliance";
}
