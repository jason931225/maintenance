import type { ConsoleApiClient } from "../../api/client";
import type { SendMailRequest } from "../../api/types";
import type { ConsoleMailThreadDetail } from "./types";

export type MailApiClient = ConsoleApiClient;

export function getMailAccount(api: MailApiClient) {
  return api.GET("/api/v1/mail/account");
}

export function listMailFolders(api: MailApiClient) {
  return api.GET("/api/v1/mail/folders");
}

export function listMailThreads(
  api: MailApiClient,
  query: { folder?: string; unread?: boolean; q?: string; limit: number },
) {
  return api.GET("/api/v1/mail/threads", {
    params: { query },
  });
}

export async function getMailThread(api: MailApiClient, id: string): Promise<ConsoleMailThreadDetail | undefined> {
  const response = await api.GET("/api/v1/mail/threads/{id}", {
    params: { path: { id } },
  });
  return response.data;
}

export function setMailThreadReadState(api: MailApiClient, id: string, seen: boolean) {
  return api.PATCH("/api/v1/mail/threads/{id}/read-state", {
    params: { path: { id } },
    body: { seen },
  });
}

export function sendMail(api: MailApiClient, body: SendMailRequest) {
  return api.POST("/api/v1/mail/send", { body });
}

export function replyMail(api: MailApiClient, body: SendMailRequest) {
  return api.POST("/api/v1/mail/reply", { body });
}

export function forwardMail(api: MailApiClient, body: SendMailRequest) {
  return api.POST("/api/v1/mail/forward", { body });
}

export function getMailAttachmentDownload(api: MailApiClient, id: string) {
  return api.GET("/api/v1/mail/attachments/{id}/download", {
    params: { path: { id } },
  });
}
