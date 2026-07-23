import {
  buildObjectLinkRequests,
  buildStartWorkflowRunRequest,
  deriveCompletionResult,
  mapSubmittableDefinition,
  type ApprComposeDraft,
  type ApprSubmittableDefinition,
  type ApprTemplate,
  type BackendRunIdentity,
  type CompletionResult,
  type CreateObjectLinkRequest,
  type FinalizeWorkflowTaskResponse,
  type ObjectLinkRef,
  type PostFinalizationRejectionResponse,
  type StartWorkflowRunRequest,
} from "./composeModel";

interface ObjectHead {
  kind: string;
  id: string;
  code?: string | null;
  title?: string | null;
  status?: string | null;
  exists: boolean;
}

interface SearchResponse {
  results: ObjectHead[];
}

interface StartWorkflowRunResponse {
  run: {
    id: string;
    status: string;
    definition_id: string;
    definition_version: number;
    object_type?: string;
    object_id?: string;
    initiated_by?: string;
    started_at: string;
  };
  next_task?: unknown;
}

interface DecideWorkflowTaskResponse {
  task: {
    task_id: string;
    run_id: string;
    status: string;
    decision_payload: Record<string, unknown>;
  };
  run: {
    id: string;
    status: string;
  };
  next_task?: unknown;
}

interface SubmittableDefinitionListResponse {
  items?: ApprSubmittableDefinition[];
  definitions?: ApprSubmittableDefinition[];
}

export interface SubmittedComposeRun {
  runId: string;
  code?: string;
  status: string;
  objectLinks: CreateObjectLinkRequest[];
}

export type WorkflowDecision = "approve" | "reject" | "return";

export interface WorkflowDecisionResult {
  taskId: string;
  runId: string;
  taskStatus: string;
  runStatus: string;
  nextTask?: unknown;
}

/** Server-owned task fields. Eligibility is deliberately derived only from these fields. */
export interface WorkflowWaitingTask {
  task_id: string;
  run_id: string;
  waiting_key: string;
  title: string;
  assignee_role_key?: string;
  required_policy?: string;
  object_type?: string;
  object_id?: string;
  status: string;
  claimed_by?: string;
  due_at?: string;
  form_payload: Record<string, unknown>;
}

export interface ApprWorkflowApi {
  listSubmittableDefinitions(): Promise<ApprTemplate[]>;
  searchObjects(query: string): Promise<ObjectLinkRef[]>;
  resolveObject(kind: string, id: string): Promise<ObjectLinkRef | undefined>;
  submitDraft(draft: ApprComposeDraft, options?: { idempotencyKey?: string; correlationId?: string }): Promise<SubmittedComposeRun>;
  listWaitingTasks(): Promise<WorkflowWaitingTask[]>;
  decideTask(taskId: string, decision: WorkflowDecision, options?: { comment?: string; idempotencyKey?: string; signal?: AbortSignal }): Promise<WorkflowDecisionResult>;
  finalizeTask(taskId: string, mode: "author" | "delegate", options?: { reason?: string; idempotencyKey?: string }): Promise<CompletionResult>;
  postFinalizationReject(runId: string, reason: string, options?: { idempotencyKey?: string }): Promise<CompletionResult>;
}

export interface ApprWorkflowApiOptions {
  baseUrl?: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export class ApprWorkflowApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApprWorkflowApiError";
    this.status = status;
  }
}

export function createApprWorkflowApi(options: ApprWorkflowApiOptions = {}): ApprWorkflowApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? defaultBaseUrl();

  async function getJson<TData>(path: string): Promise<TData> {
    return requestJson<TData>(fetchImpl, baseUrl, path, {
      method: "GET",
      headers: headers(options.bearerToken),
    });
  }

  async function postJson<TData>(path: string, body: unknown, signal?: AbortSignal): Promise<TData> {
    return requestJson<TData>(fetchImpl, baseUrl, path, {
      method: "POST",
      headers: headers(options.bearerToken, true),
      body: JSON.stringify(body),
      signal,
    });
  }

  async function resolveObject(kind: string, id: string): Promise<ObjectLinkRef | undefined> {
    const head = await getJson<ObjectHead>(
      `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    );
    return objectHeadToLinkRef(head)[0];
  }

  const api: ApprWorkflowApi = {
    async listSubmittableDefinitions() {
      const response = await getJson<SubmittableDefinitionListResponse | ApprSubmittableDefinition[]>(
        "/api/v1/workflow-studio/submittable-definitions",
      );
      const items = Array.isArray(response) ? response : response.items ?? response.definitions ?? [];
      return items.map(mapSubmittableDefinition);
    },

    async searchObjects(query: string) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const response = await getJson<SearchResponse>(
        `/api/v1/search?q=${encodeURIComponent(trimmed)}&limit=20`,
      );
      return response.results.flatMap(objectHeadToLinkRef);
    },

    resolveObject,

    async submitDraft(draft, submitOptions) {
      const request = buildStartWorkflowRunRequest(draft, {
        idempotencyKey: submitOptions?.idempotencyKey ?? newIdempotencyKey("appr-start"),
        correlationId: submitOptions?.correlationId,
      });
      const response = await postJson<StartWorkflowRunResponse>("/api/v1/workflow-runs", request);
      const runIdentity = await resolveRunIdentity({ runId: response.run.id }, resolveObject);
      const linkRequests = buildObjectLinkRequests(runIdentity, draft.targets);
      for (const link of linkRequests) {
        await postJson("/api/v1/object-links", link);
      }
      return {
        runId: response.run.id,
        code: runIdentity.code,
        status: response.run.status,
        objectLinks: linkRequests,
      };
    },

    async listWaitingTasks() {
      const response = await getJson<{ items?: WorkflowWaitingTask[] }>(
        "/api/v1/workflow-tasks?assignee=me&status=OPEN,CLAIMED",
      );
      return response.items ?? [];
    },

    async decideTask(taskId, decision, decideOptions) {
      const response = await postJson<DecideWorkflowTaskResponse>(
        `/api/v1/workflow-tasks/${encodeURIComponent(taskId)}/decide`,
        {
          decision,
          comment: decideOptions?.comment,
          idempotency_key: decideOptions?.idempotencyKey ?? newIdempotencyKey(`appr-decide-${taskId}-${decision}`),
        },
        decideOptions?.signal,
      );
      return {
        taskId: response.task.task_id,
        runId: response.task.run_id,
        taskStatus: response.task.status,
        runStatus: response.run.status,
        nextTask: response.next_task,
      };
    },

    async finalizeTask(taskId, mode, finalizeOptions) {
      const body = {
        mode,
        reason: finalizeOptions?.reason,
        idempotency_key: finalizeOptions?.idempotencyKey ?? newIdempotencyKey(`appr-finalize-${taskId}`),
      };
      const response = await postJson<FinalizeWorkflowTaskResponse>(
        `/api/v1/workflow-tasks/${encodeURIComponent(taskId)}/finalize`,
        body,
      );
      return deriveCompletionResult(response);
    },

    async postFinalizationReject(runId, reason, rejectOptions) {
      const response = await postJson<PostFinalizationRejectionResponse>(
        `/api/v1/workflow-runs/${encodeURIComponent(runId)}/post-finalization-rejection`,
        {
          reason,
          idempotency_key: rejectOptions?.idempotencyKey ?? newIdempotencyKey(`appr-post-reject-${runId}`),
        },
      );
      return deriveCompletionResult(response);
    },
  };

  return api;
}

async function resolveRunIdentity(
  run: BackendRunIdentity,
  resolveObject: ApprWorkflowApi["resolveObject"],
): Promise<BackendRunIdentity> {
  const resolved = await resolveObject("approval_run", run.runId).catch(() => undefined);
  return { runId: run.runId, code: resolved?.code ?? run.code };
}

async function requestJson<TData>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<TData> {
  const response = await fetchImpl(new URL(path, baseUrl), init);
  if (!response.ok) {
    throw new ApprWorkflowApiError(response.status, await errorMessage(response));
  }
  if (response.status === 204) return undefined as TData;
  return (await response.json()) as TData;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${String(response.status)}`;
  try {
    const body = (await response.clone().json()) as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (typeof body.code === "string") return body.code;
  } catch {
    // fall through to text/fallback
  }
  try {
    const text = await response.text();
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function objectHeadToLinkRef(head: ObjectHead): ObjectLinkRef[] {
  if (!head.exists) return [];
  return [
    {
      kind: head.kind,
      id: head.id,
      code: head.code ?? undefined,
      label: head.title ?? head.code ?? `${head.kind} ${head.id}`,
      policyAction: "object_link_read",
    },
  ];
}

function headers(bearerToken: string | undefined, json = false): HeadersInit {
  const nextHeaders: Record<string, string> = { Accept: "application/json" };
  if (json) nextHeaders["Content-Type"] = "application/json";
  if (bearerToken) nextHeaders.Authorization = `Bearer ${bearerToken}`;
  return nextHeaders;
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost";
}

function newIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2)}`;
}

export type { ObjectHead, SearchResponse, StartWorkflowRunRequest };
