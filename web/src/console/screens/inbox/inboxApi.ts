// 개인 수신함 (statutory-notice vault) data access — the three REAL person-scoped
// inbox-doc endpoints. Scope is bound server-side from the caller's JWT (the
// recipient is never taken from a path/body), so wiring is just the typed client.
//
// confirm-receipt is a LEGAL act: the backend requires a fresh passkey step-up
// (428 without one), so `confirmReceipt` performs the same WebAuthn assertion
// (`assertPasskeyStepUp`) workflow-studio publication uses, then POSTs it.

import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../../api/client";
import { assertPasskeyStepUp } from "../../../auth/webauthn";

export type InboxDocSummary = components["schemas"]["InboxDocSummary"];
export type InboxDocDetail = components["schemas"]["InboxDocDetail"];
export type InboxDocPage = components["schemas"]["InboxDocPage"];
export type InboxDocKind = InboxDocSummary["kind"]; // "payslip" | "legal_notice"

/** The four server-side filters (`filter` query enum): 전체·확인 필요·급여명세·완료. */
export type InboxFilter = "all" | "action" | "pay" | "done";

export interface InboxApi {
  loadDocs(filter: InboxFilter): Promise<InboxDocSummary[]>;
  loadDoc(id: string): Promise<InboxDocDetail>;
  /** Confirm receipt of a locked legal notice. Performs a fresh passkey
   *  step-up (the legal act) then POSTs the assertion; the returned summary
   *  carries the confirmed stamp. Rejects if the user cancels the passkey. */
  confirmReceipt(id: string): Promise<InboxDocSummary>;
}

export function createInboxApi(client: ConsoleApiClient): InboxApi {
  return {
    loadDocs: async (filter) => {
      const { data } = await client.GET("/api/v1/me/inbox-docs", {
        params: { query: { filter, limit: 100 } },
      });
      if (!data) throw new Error("inbox list failed");
      return data.items;
    },
    loadDoc: async (id) => {
      const { data } = await client.GET("/api/v1/me/inbox-docs/{id}", {
        params: { path: { id } },
      });
      if (!data) throw new Error("inbox doc failed");
      return data;
    },
    confirmReceipt: async (id) => {
      // The receipt IS the legal act — assert a fresh passkey first. A user
      // cancel throws here and the caller keeps the doc locked (fail-closed).
      const stepUp = await assertPasskeyStepUp(client);
      const { data } = await client.POST(
        "/api/v1/me/inbox-docs/{id}/confirm-receipt",
        { params: { path: { id } }, body: { step_up: stepUp } },
      );
      if (!data) throw new Error("confirm receipt failed");
      return data;
    },
  };
}
