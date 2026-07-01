import { useEffect, useId, useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useAuth } from "../../context/auth";

type EvidenceSummary = components["schemas"]["EvidenceSummary"];
type AttachmentStage = components["schemas"]["AttachmentStage"];


interface EvidencePreview {
  thumbnailUrl: string;
  processedAt?: string;
}
/**
 * Human label for an attachment stage. The mechanic-facing categories
 * (DURING/REQUEST/AFTER) have Korean labels; the remaining backend stages
 * (BEFORE/REPORT/OUTSOURCE_RESULT) are rare on this surface and fall back to the
 * raw code rather than leaking a blank.
 */
function stageLabel(stage: AttachmentStage): string {
  const categories = ko.workOrder.evidence.categories;
  if (stage === "DURING" || stage === "REQUEST" || stage === "AFTER") {
    return categories[stage];
  }
  return stage;
}

interface WorkOrderEvidenceListProps {
  /** The evidence summaries embedded on WorkOrderDetail.evidence[]. */
  evidence: EvidenceSummary[];
}

/**
 * Read-only evidence list for the work-order detail view. The embedded
 * `EvidenceSummary` carries no thumbnail URL, so for each item we fetch the
 * evidence status endpoint (the same one the uploader polls) to obtain a
 * short-lived presigned `thumbnail_url` and render it when READY. Failures are
 * tolerated silently — the row still shows its stage/time metadata.
 */
export function WorkOrderEvidenceList({ evidence }: WorkOrderEvidenceListProps) {
  const { api } = useAuth();
  const t = ko.workOrder.detail;
  const [previews, setPreviews] = useState<Partial<Record<string, EvidencePreview>>>({});
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const titleId = useId();

  useEffect(() => {
    let ignore = false;
    async function loadThumbnails() {
      const results = await Promise.all(
        evidence.map(async (item) => {
          const { data } = await api
            .GET("/api/v1/evidence/{evidenceId}/status", {
              params: { path: { evidenceId: item.id } },
            })
            .catch(() => ({ data: undefined }));
          return data?.thumbnail_url
            ? ([
                item.id,
                {
                  thumbnailUrl: data.thumbnail_url,
                  processedAt: data.processed_at,
                },
              ] as const)
            : undefined;
        }),
      );
      if (ignore) return;
      const next: Partial<Record<string, EvidencePreview>> = {};
      for (const entry of results) {
        if (entry) next[entry[0]] = entry[1];
      }
      setPreviews(next);
    }
    if (evidence.length > 0) void loadThumbnails();
    return () => {
      ignore = true;
    };
  }, [api, evidence]);

  if (evidence.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
        {t.evidenceEmpty}
      </p>
    );
  }

  const selectedEvidence = evidence.find((item) => item.id === selectedEvidenceId);
  const selectedPreview = selectedEvidenceId ? previews[selectedEvidenceId] : undefined;

  return (
    <>
      <ul className="grid gap-2 sm:grid-cols-2">
        {evidence.map((item) => {
          const preview = previews[item.id];
          const metaLabel = `${stageLabel(item.stage)} · ${item.content_type}`;
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-md border border-line p-2"
            >
              {preview ? (
                <button
                  type="button"
                  className="h-14 w-14 flex-shrink-0 overflow-hidden rounded focus:outline-none focus:ring-2 focus:ring-brand-teal"
                  aria-label={`${metaLabel} ${t.evidenceOpenPreview}`}
                  onClick={() => {
                    setSelectedEvidenceId(item.id);
                  }}
                >
                  <img
                    src={preview.thumbnailUrl}
                    alt={t.evidenceThumbAlt}
                    className="h-full w-full object-cover"
                  />
                </button>
              ) : (
                <div
                  aria-hidden="true"
                  className="h-14 w-14 flex-shrink-0 rounded bg-muted-panel"
                />
              )}
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">
                  {stageLabel(item.stage)}
                  {item.verified_at ? (
                    <span className="ml-1 text-brand-teal">
                      · {t.evidenceVerified}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-steel">{item.content_type}</p>
                <p className="text-steel">{formatKoreanDateTime(item.created_at)}</p>
                {preview ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        setSelectedEvidenceId(item.id);
                      }}
                    >
                      {t.evidenceOpenPreview}
                    </Button>
                    <a
                      className="inline-flex min-h-7 items-center rounded-md border border-line px-2 text-xs font-semibold text-brand-teal"
                      href={preview.thumbnailUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.evidenceOpenFile}
                    </a>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={Boolean(selectedEvidence && selectedPreview)}
        onClose={() => {
          setSelectedEvidenceId(undefined);
        }}
        titleId={titleId}
        className="max-w-3xl"
      >
        {selectedEvidence && selectedPreview ? (
          <div className="grid gap-3">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink">
                {t.evidenceViewerTitle}
              </h2>
              <p className="text-sm text-steel">
                {stageLabel(selectedEvidence.stage)} · {selectedEvidence.content_type}
              </p>
            </div>
            <img
              src={selectedPreview.thumbnailUrl}
              alt={t.evidenceThumbAlt}
              className="max-h-[70vh] w-full rounded-md object-contain"
            />
            <dl className="grid gap-2 rounded-md bg-muted-panel p-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium text-steel">{t.evidenceUploadedAt}</dt>
                <dd className="text-ink">
                  {formatKoreanDateTime(selectedEvidence.created_at)}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-steel">{t.evidenceProcessedAt}</dt>
                <dd className="text-ink">
                  {selectedPreview.processedAt
                    ? formatKoreanDateTime(selectedPreview.processedAt)
                    : ko.common.notSet}
                </dd>
              </div>
            </dl>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSelectedEvidenceId(undefined);
                }}
              >
                {ko.common.close}
              </Button>
              <a
                className="inline-flex min-h-9 items-center rounded-md bg-brand-teal px-3 text-sm font-semibold text-white"
                href={selectedPreview.thumbnailUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t.evidenceOpenFile}
              </a>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
