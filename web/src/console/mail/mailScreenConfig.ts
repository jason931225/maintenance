import { ko } from "../../i18n/ko";
import type {
  ConsoleMailAttachment,
  ConsoleMailMessage,
  ConsoleMailThread,
  MailAuthResult,
  MailClassification,
  MailEgressBlock,
  MailEgressReason,
  MailGovernance,
  MailSenderAuth,
  MailStorageEncryption,
  MailTlsResult,
} from "./types";

export const MAIL_ACTIONS = {
  read: "mail.use",
  send: "mail.send",
  reply: "mail.reply",
  forward: "mail.forward",
  markRead: "mail.mark_read",
  attachmentDownload: "mail.attachment.download",
  attachmentIngest: "mail.attachment.ingest",
  evidenceRegister: "mail.evidence.register",
  governanceView: "mail.governance.view",
  egressExternal: "mail.egress.external",
} as const;

export type StatusTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";

export interface MailChipConfig {
  key: string;
  label: string;
  tone: StatusTone;
  role?: "status" | "alert";
}

const T = ko.console.mail;

export const CLASSIFICATION_OPTIONS: Array<{ value: MailClassification; label: string; tone: StatusTone }> = [
  { value: "normal", label: T.classification.normal, tone: "neutral" },
  { value: "confidential", label: T.classification.confidential, tone: "warn" },
  { value: "sensitive", label: T.classification.sensitive, tone: "danger" },
  { value: "quarantine", label: T.classification.quarantine, tone: "danger" },
];

export function folderRoleLabel(role: string, fallback: string): string {
  const key = role.toLowerCase();
  if (key === "inbox") return T.folder.inbox;
  if (key === "sent") return T.folder.sent;
  if (key === "drafts") return T.folder.drafts;
  if (key === "archive") return T.folder.archive;
  if (key === "trash") return T.folder.trash;
  if (key === "junk") return T.folder.junk;
  if (key === "custom") return T.folder.custom;
  return fallback || T.folder.custom;
}

export function classificationChip(classification: MailClassification | undefined): MailChipConfig | undefined {
  if (!classification) return undefined;
  const option = CLASSIFICATION_OPTIONS.find((item) => item.value === classification);
  if (!option) return undefined;
  return {
    key: `classification:${classification}`,
    label: option.label,
    tone: option.tone,
    role: option.tone === "danger" ? "alert" : "status",
  };
}

export function governanceChips(governance: MailGovernance | undefined): MailChipConfig[] {
  if (!governance) return [];
  const chips: MailChipConfig[] = [];
  const classification = classificationChip(governance.classification);
  if (classification) chips.push(classification);
  if (governance.retention_label) {
    chips.push({
      key: `retention:${governance.retention_label}`,
      label: T.governance.retention(governance.retention_label),
      tone: governance.retention_state === "expired" ? "warn" : "info",
      role: "status",
    });
  }
  if (governance.litigation_hold) {
    chips.push({ key: "litigation_hold", label: T.governance.litigationHold, tone: "danger", role: "alert" });
  }
  if (governance.pbac_decision === "step_up_required") {
    chips.push({ key: "step_up", label: T.governance.stepUpRequired, tone: "warn", role: "status" });
  }
  for (const ref of governance.object_refs ?? []) {
    chips.push({ key: `object:${ref.code}`, label: ref.code, tone: "purple", role: "status" });
  }
  return chips;
}

function authTone(result: MailAuthResult | MailTlsResult | MailStorageEncryption | undefined): StatusTone {
  if (result === "pass" || result === "verified" || result === "encrypted") return "ok";
  if (result === "fail" || result === "none") return "danger";
  if (result === "opportunistic") return "warn";
  return "neutral";
}

function authResultLabel(result: MailAuthResult | MailTlsResult | MailStorageEncryption | undefined): string {
  if (result === "pass") return T.senderAuth.pass;
  if (result === "fail") return T.senderAuth.fail;
  if (result === "neutral") return T.senderAuth.neutral;
  if (result === "verified") return T.senderAuth.verified;
  if (result === "opportunistic") return T.senderAuth.opportunistic;
  if (result === "none") return T.senderAuth.none;
  if (result === "encrypted") return T.senderAuth.pass;
  return T.senderAuth.unknown;
}

function senderAuthChip(key: string, label: string, result: MailAuthResult | MailTlsResult | MailStorageEncryption | undefined): MailChipConfig | undefined {
  if (!result) return undefined;
  const resultLabel = authResultLabel(result);
  return {
    key,
    label: T.senderAuth.result(label, resultLabel),
    tone: authTone(result),
    role: result === "fail" || result === "none" ? "alert" : "status",
  };
}

export function senderAuthChips(auth: MailSenderAuth | undefined): MailChipConfig[] {
  if (!auth) return [];
  return [
    senderAuthChip("spf", T.senderAuth.spf, auth.spf),
    senderAuthChip("dkim", T.senderAuth.dkim, auth.dkim),
    senderAuthChip("dmarc", T.senderAuth.dmarc, auth.dmarc),
    senderAuthChip("tls", T.senderAuth.tls, auth.tls),
    senderAuthChip("encrypted", T.senderAuth.encrypted, auth.storage_encryption),
  ].filter((chip): chip is MailChipConfig => Boolean(chip));
}

export function threadChips(thread: ConsoleMailThread): MailChipConfig[] {
  const chips: MailChipConfig[] = [
    { key: "messages", label: T.thread.conversationCount(thread.message_count), tone: "neutral", role: "status" },
  ];
  if (thread.unread_count > 0) {
    chips.push({ key: "unread", label: T.thread.unreadCount(thread.unread_count), tone: "accent", role: "status" });
  }
  if (thread.has_attachments) {
    chips.push({ key: "attachment", label: T.thread.attachment, tone: "info", role: "status" });
  }
  if (thread.is_flagged) {
    chips.push({ key: "flagged", label: T.thread.flagged, tone: "warn", role: "status" });
  }
  if (thread.spam || thread.governance?.classification === "quarantine") {
    chips.push({ key: "spam", label: T.thread.spam, tone: "danger", role: "alert" });
  }
  return [...chips, ...governanceChips(thread.governance)];
}

export function attachmentStateChips(attachment: ConsoleMailAttachment): MailChipConfig[] {
  const chips: MailChipConfig[] = [];
  if (attachment.ingest_code) {
    chips.push({ key: "ingest", label: attachment.ingest_code, tone: "purple", role: "status" });
  }
  if (attachment.evidence_code) {
    chips.push({ key: "evidence", label: attachment.evidence_code, tone: "info", role: "status" });
  }
  return [...chips, ...governanceChips(attachment.governance)];
}

export function messageGovernance(message: ConsoleMailMessage): MailGovernance | undefined {
  return message.governance;
}

export function egressReasonLabel(reason: MailEgressReason): string {
  return T.egress[reason];
}

export function egressNextActionLabel(nextAction: MailEgressBlock["nextAction"]): string {
  return T.egress[nextAction];
}

export const mailScreenConfig = {
  actions: MAIL_ACTIONS,
  classificationOptions: CLASSIFICATION_OPTIONS,
  folderRoleLabel,
  threadChips,
  governanceChips,
  senderAuthChips,
  attachmentStateChips,
  egressReasonLabel,
  egressNextActionLabel,
};
