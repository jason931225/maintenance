import { useEffect, useState } from "react";

import type { components } from "@maintenance/api-client-ts";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { useAuth } from "../../context/auth";

type EvidenceSummary = components["schemas"]["EvidenceSummary"];
type AttachmentStage = components["schemas"]["AttachmentStage"];

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
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

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
            ? ([item.id, data.thumbnail_url] as const)
            : undefined;
        }),
      );
      if (ignore) return;
      const next: Record<string, string> = {};
      for (const entry of results) {
        if (entry) next[entry[0]] = entry[1];
      }
      setThumbnails(next);
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

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {evidence.map((item) => (
        <li
          key={item.id}
          className="flex items-center gap-3 rounded-md border border-line p-2"
        >
          {thumbnails[item.id] ? (
            <img
              src={thumbnails[item.id]}
              alt={t.evidenceThumbAlt}
              className="h-14 w-14 flex-shrink-0 rounded object-cover"
            />
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
          </div>
        </li>
      ))}
    </ul>
  );
}
