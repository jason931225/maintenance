import { useCallback, useRef, useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { ko } from "../../i18n/ko";
import { useAuth } from "../../context/auth";

type AttachmentStage = components["schemas"]["AttachmentStage"];
type ProcessingStatus = components["schemas"]["ProcessingStatus"];

// The mechanic-facing evidence categories (maintenance / symptom / proof) map
// onto the existing attachment-stage taxonomy: maintenance = work evidence
// (DURING), symptom = the reported issue (REQUEST), proof = completion evidence
// (AFTER). The Korean labels live in ko.workOrder.evidence.categories.
const CATEGORY_STAGES: AttachmentStage[] = ["DURING", "REQUEST", "AFTER"];

// Client-side mirror of the server allowlist + per-kind caps so an oversize or
// disallowed file is rejected before any presign round-trip. The server
// re-validates authoritatively.
const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const ALLOWED_VIDEO = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const STATUS_LABELS: Record<ProcessingStatus, string> = {
  PROCESSING: ko.workOrder.evidence.statusProcessing,
  READY: ko.workOrder.evidence.statusReady,
  FAILED: ko.workOrder.evidence.statusFailed,
};

type UploadItem = {
  localId: string;
  fileName: string;
  evidenceId?: string;
  status: ProcessingStatus;
  error?: string;
  thumbnailUrl?: string;
};

interface EvidenceUploadProps {
  workOrderId: string;
}

function normalizeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Mechanic evidence upload affordance for a single work order. Picks photo/video
 * files under a maintenance/symptom/proof category, uploads each ORIGINAL to a
 * tenant-scoped staging key via presign, then polls the server-side processing
 * status (processing -> ready/failed), showing the result when READY.
 */
export function EvidenceUpload({ workOrderId }: EvidenceUploadProps) {
  const { api } = useAuth();
  const t = ko.workOrder.evidence;
  const [stage, setStage] = useState<AttachmentStage>("DURING");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic counter for per-upload list keys (no crypto dependency).
  const nextLocalId = useRef(0);

  const updateItem = useCallback(
    (localId: string, patch: Partial<UploadItem>) => {
      setItems((prev) =>
        prev.map((it) => (it.localId === localId ? { ...it, ...patch } : it)),
      );
    },
    [],
  );

  const pollStatus = useCallback(
    async (localId: string, evidenceId: string) => {
      // Bounded poll: PROCESSING → READY/FAILED. Stops on terminal status.
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { data } = await api.GET(
          "/api/v1/evidence/{evidenceId}/status",
          { params: { path: { evidenceId } } },
        );
        if (!data) continue;
        if (data.processing_status === "READY") {
          updateItem(localId, { status: "READY" });
          return;
        }
        if (data.processing_status === "FAILED") {
          updateItem(localId, {
            status: "FAILED",
            error: data.processing_error ?? t.processingFailed,
          });
          return;
        }
      }
    },
    [api, t.processingFailed, updateItem],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      const mediaType = normalizeType(file.type);
      const isImage = ALLOWED_IMAGE.includes(mediaType);
      const isVideo = ALLOWED_VIDEO.includes(mediaType);
      nextLocalId.current += 1;
      const localId = `evidence-${nextLocalId.current}`;

      if (!isImage && !isVideo) {
        setItems((prev) => [
          ...prev,
          {
            localId,
            fileName: file.name,
            status: "FAILED",
            error: t.rejectedType,
          },
        ]);
        return;
      }
      const cap = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (file.size > cap) {
        setItems((prev) => [
          ...prev,
          {
            localId,
            fileName: file.name,
            status: "FAILED",
            error: isImage ? t.rejectedSizeImage : t.rejectedSizeVideo,
          },
        ]);
        return;
      }

      setItems((prev) => [
        ...prev,
        { localId, fileName: file.name, status: "PROCESSING" },
      ]);

      const { data } = await api.POST("/api/v1/evidence/staging-presign", {
        body: {
          work_order_id: workOrderId,
          stage,
          content_type: file.type,
          size_bytes: file.size,
        },
      });
      if (!data) {
        updateItem(localId, { status: "FAILED", error: t.uploadFailed });
        return;
      }

      // PUT the ORIGINAL straight to the presigned staging URL (not via the API
      // client). The server-side worker transcodes/optimizes it before storage.
      try {
        const headers = new Headers();
        for (const [name, value] of data.upload.headers) {
          headers.set(name, value);
        }
        const putResponse = await fetch(data.upload.url, {
          method: data.upload.method,
          headers,
          body: file,
        });
        if (!putResponse.ok) {
          updateItem(localId, { status: "FAILED", error: t.uploadFailed });
          return;
        }
      } catch {
        updateItem(localId, { status: "FAILED", error: t.uploadFailed });
        return;
      }

      updateItem(localId, { evidenceId: data.id, status: "PROCESSING" });
      void pollStatus(localId, data.id);
    },
    [api, pollStatus, stage, t, updateItem, workOrderId],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setBusy(true);
      const files = Array.from(fileList);
      for (const file of files) {
        await uploadFile(file);
      }
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadFile],
  );

  return (
    <div className="grid gap-3 rounded-md border border-line p-3">
      <div>
        <p className="font-semibold text-ink">{t.title}</p>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-steel">{t.category}</span>
          <Select
            value={stage}
            onChange={(event) => {
              setStage(event.target.value as AttachmentStage);
            }}
          >
            {CATEGORY_STAGES.map((value) => (
              <option key={value} value={value}>
                {t.categories[value as keyof typeof t.categories]}
              </option>
            ))}
          </Select>
        </label>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={[...ALLOWED_IMAGE, ...ALLOWED_VIDEO].join(",")}
          className="text-sm"
          aria-label={t.pickFiles}
          disabled={busy}
          onChange={(event) => {
            void handleFiles(event.target.files);
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy ? t.uploading : t.pickFiles}
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-steel">{t.noFiles}</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((item) => (
            <li
              key={item.localId}
              className="flex items-center justify-between gap-3 rounded border border-line px-3 py-2 text-sm"
            >
              <span className="truncate text-ink">{item.fileName}</span>
              <span
                className={
                  item.status === "FAILED"
                    ? "text-red-600"
                    : item.status === "READY"
                      ? "text-emerald-700"
                      : "text-steel"
                }
              >
                {t.statusLabel}: {STATUS_LABELS[item.status]}
                {item.error ? ` (${item.error})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
