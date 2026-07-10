import type { MailAddress, SendMailRequest } from "../../api/types";
import { ko } from "../../i18n/ko";
import type { ConsoleMailAttachment, ConsoleMailMessage } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_CODE_RE = /\b(?:WO|AP|CS|DX|EV|C|OB|OT|SR|VC)-[A-Za-z0-9-]+\b/g;

export const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function isValidEmail(address: string): boolean {
  return EMAIL_RE.test(address);
}

export function parseRecipients(value: string): SendMailRequest["to"] {
  return value
    .split(/[;,\s]+/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

export function names(addresses: MailAddress[]): string {
  return addresses.map((address) => address.name || address.address).join(", ");
}

export function textBody(message: ConsoleMailMessage): string {
  return message.body_text || message.snippet || ko.console.mail.read.emptyBody;
}

export function formatMailDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function attachmentLabel(attachment: ConsoleMailAttachment): string {
  return attachment.size_bytes > 0
    ? `${attachment.filename} · ${formatBytes(attachment.size_bytes)}`
    : attachment.filename;
}

export function fileAttachmentLabel(file: File): string {
  return `${file.name} · ${formatBytes(file.size)}`;
}

export function totalAttachmentBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fileToMailAttachment(
  file: File,
): Promise<NonNullable<SendMailRequest["attachments"]>[number]> {
  return {
    filename: file.name,
    content_type: file.type || "application/octet-stream",
    content_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  };
}

export function uniqueReferences(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
  );
}

export function buildThreadReferences(message: ConsoleMailMessage): string[] {
  return uniqueReferences([message.in_reply_to, message.message_id]);
}

export function replyRecipients(message: ConsoleMailMessage): string {
  if (message.direction === "OUT" && message.to.length > 0) {
    return message.to.map((address) => address.address).join(", ");
  }
  return message.from_address;
}

export function replySubject(subject: string): string {
  const cleanSubject = subject.trim();
  if (/^re:/i.test(cleanSubject)) return cleanSubject;
  return `Re: ${cleanSubject}`;
}

export function forwardSubject(subject: string): string {
  const cleanSubject = subject.trim();
  if (/^(fwd|fw):/i.test(cleanSubject)) return cleanSubject;
  return `Fwd: ${cleanSubject}`;
}

export function originalMessageBlock(message: ConsoleMailMessage, subject: string): string {
  const T = ko.console.mail.composer;
  const from = message.from_name
    ? `${message.from_name} <${message.from_address}>`
    : message.from_address;
  return [
    "",
    "",
    T.originalMessage,
    `${T.originalFrom}: ${from}`,
    `${T.originalAt}: ${formatMailDate(message.received_at)}`,
    `${T.originalSubject}: ${subject}`,
    "",
    textBody(message),
  ].join("\n");
}

export function safeAttachmentDownloadUrl(raw: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const url = new URL(raw, window.location.origin);
    const isHttps = url.protocol === "https:";
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        (url.origin === window.location.origin && window.location.protocol === "http:"));
    return isHttps || isLocalHttp ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function splitObjectCodes(text: string): Array<{ text: string; code?: string }> {
  const parts: Array<{ text: string; code?: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(OBJECT_CODE_RE)) {
    const index = match.index;
    if (index > lastIndex) parts.push({ text: text.slice(lastIndex, index) });
    parts.push({ text: match[0], code: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ text }];
}
