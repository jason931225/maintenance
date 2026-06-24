import { ArrowLeftRight, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  EquipmentListItem,
  EquipmentSummary,
  SiteLocationGroup,
  SubstituteAssignment,
  SubstituteCandidate,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { ko } from "../../i18n/ko";

interface SubstitutionPanelProps {
  api: ConsoleApiClient;
  /** Equipment rows surfaced by the page search — the substitution source pool. */
  results: EquipmentSummary[];
  /**
   * Whether the principal may assign/return substitutes (EquipmentManage).
   * Reading substitute candidates is allowed for any read-access role (mechanics
   * included), so the source picker and lookup are always shown; only the
   * mutation controls (assign / return) require this flag.
   */
  canManage: boolean;
}

type WriteState = "idle" | "loading" | "error";

/** The status the API expects for rented (임대) units — the sources that break
 * down and need a 대차. Sourced from the EquipmentStatus enum. */
const STATUS_RENTED = "rented" as const;

const t = ko.equipment.substitution;

function matchLabel(kind: SubstituteCandidate["match_kind"]): string {
  return kind === "nearest_above" ? t.matchNearest : t.matchExact;
}

/** Source-picker option label: management_no (falling back to equipment_no) and
 * the model, e.g. "290 · GTS25DE". Never shows a raw UUID. */
function equipmentLabel(
  managementNo: string | null | undefined,
  equipmentNo: string,
  model: string | null | undefined,
): string {
  return `${managementNo ?? equipmentNo} · ${model ?? ko.common.unknown}`;
}

/** One row per site_id, sorted by site name, for the source-by-site picker. The
 * by-location read is already grouped by site, but dedupe defensively. */
function dedupeSites(sites: SiteLocationGroup[]): SiteLocationGroup[] {
  const seen = new Map<string, SiteLocationGroup>();
  for (const site of sites) {
    if (!seen.has(site.site_id)) seen.set(site.site_id, site);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.site_name.localeCompare(b.site_name, "ko"),
  );
}

/** Power-type label for a candidate: the API's power_label when present, else a
 * label derived from the single-letter power_code (mirrors the backend
 * power_family: B→battery, O/D→diesel, L→lpg). */
function powerLabel(candidate: SubstituteCandidate): string {
  if (candidate.power_label) return candidate.power_label;
  switch (candidate.power_code) {
    case "B":
      return t.powerBattery;
    case "O":
    case "D":
      return t.powerDiesel;
    case "L":
      return t.powerLpg;
    default:
      return t.powerUnknown;
  }
}

export function SubstitutionPanel({
  api,
  results,
  canManage,
}: SubstitutionPanelProps) {
  const [sites, setSites] = useState<SiteLocationGroup[]>([]);
  // Starts "loading": the on-mount effect fetches the site list immediately.
  const [siteState, setSiteState] = useState<WriteState>("loading");
  const [siteId, setSiteId] = useState<string>("");
  const [siteEquipment, setSiteEquipment] = useState<EquipmentListItem[]>();
  const [siteEquipmentState, setSiteEquipmentState] =
    useState<WriteState>("idle");
  const [sourceId, setSourceId] = useState<string>("");
  const [candidates, setCandidates] = useState<SubstituteCandidate[]>();
  const [searchState, setSearchState] = useState<WriteState>("idle");
  const [assignmentLocation, setAssignmentLocation] = useState("");
  const [assignState, setAssignState] = useState<WriteState>("idle");
  const [assignment, setAssignment] = useState<SubstituteAssignment>();
  const [returnNote, setReturnNote] = useState("");
  const [returnState, setReturnState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();

  // Load the org's sites once on mount so an operator can pick the broken unit
  // by its current site instead of searching by 호기. Aborts on unmount so the
  // request can't setState after teardown.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      void api
        .GET("/api/v1/equipment-by-location", { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;
          if (response.data) {
            setSites(response.data.items);
            setSiteState("idle");
          } else {
            setSiteState("error");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setSiteState("error");
        });
    });
    return () => {
      controller.abort();
    };
  }, [api]);

  async function selectSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    setSourceId("");
    setCandidates(undefined);
    setAssignment(undefined);
    if (!nextSiteId) {
      setSiteEquipment(undefined);
      setSiteEquipmentState("idle");
      return;
    }
    setSiteEquipmentState("loading");
    const response = await api.GET("/api/v1/equipment/list", {
      params: { query: { site_id: nextSiteId, status: STATUS_RENTED } },
    });
    if (response.data) {
      setSiteEquipment(response.data.items);
      setSiteEquipmentState("idle");
    } else {
      setSiteEquipment(undefined);
      setSiteEquipmentState("error");
    }
  }

  // When a site is chosen the source list is its rented units; otherwise it
  // falls back to the page-search results so the 호기 search flow still works.
  // The two paths return different shapes (list items carry equipment_id, search
  // hits carry id), so normalize both to { id, label } for the picker.
  const sourceOptions: { id: string; label: string }[] = siteId
    ? (siteEquipment ?? []).map((item) => ({
        id: item.equipment_id,
        label: equipmentLabel(item.management_no, item.equipment_no, item.model),
      }))
    : results.map((equipment) => ({
        id: equipment.id,
        label: equipmentLabel(
          equipment.management_no,
          equipment.equipment_no,
          equipment.model,
        ),
      }));

  async function findCandidates() {
    if (!sourceId) return;
    setSearchState("loading");
    setNotice(undefined);
    const response = await api.GET("/api/v1/equipment/{id}/substitutes", {
      params: { path: { id: sourceId } },
    });
    if (response.data) {
      setCandidates(response.data.items);
      setSearchState("idle");
    } else {
      setSearchState("error");
    }
  }

  async function assign(candidate: SubstituteCandidate) {
    if (!sourceId || !assignmentLocation.trim()) return;
    setAssignState("loading");
    setNotice(undefined);
    const response = await api.POST("/api/v1/equipment-substitutions", {
      body: {
        source_equipment_id: sourceId,
        substitute_equipment_id: candidate.equipment_id,
        assignment_location: assignmentLocation.trim(),
      },
    });
    if (response.data) {
      setAssignment(response.data);
      setCandidates(undefined);
      setAssignState("idle");
      setNotice(t.assignSuccess);
    } else {
      setAssignState("error");
      setNotice(t.assignFailed);
    }
  }

  async function returnSubstitute() {
    if (!assignment) return;
    setReturnState("loading");
    setNotice(undefined);
    const trimmedNote = returnNote.trim();
    const response = await api.POST(
      "/api/v1/equipment-substitutions/{id}/return",
      {
        params: { path: { id: assignment.id } },
        body: trimmedNote ? { return_note: trimmedNote } : {},
      },
    );
    if (response.data) {
      setAssignment(undefined);
      setReturnNote("");
      setReturnState("idle");
      setNotice(t.returnSuccess);
    } else {
      setReturnState("error");
      setNotice(t.returnFailed);
    }
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>

      {notice ? (
        <p role="status" className="text-sm font-medium text-brand-teal">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="substitution-site"
        >
          {t.siteLabel}
        </label>
        <Select
          id="substitution-site"
          value={siteId}
          onChange={(event) => {
            void selectSite(event.currentTarget.value);
          }}
        >
          <option value="">
            {siteState === "loading" ? t.siteLoading : t.selectSite}
          </option>
          {dedupeSites(sites).map((site) => (
            <option key={site.site_id} value={site.site_id}>
              {site.site_name} · {site.customer_name}
            </option>
          ))}
        </Select>
        {siteState === "error" ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {t.siteLoadFailed}
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-2">
          <label
            className="text-sm font-medium text-steel"
            htmlFor="substitution-source"
          >
            {t.sourceLabel}
          </label>
          <Select
            id="substitution-source"
            value={sourceId}
            disabled={siteId !== "" && siteEquipmentState === "loading"}
            onChange={(event) => {
              setSourceId(event.currentTarget.value);
              setCandidates(undefined);
              setAssignment(undefined);
            }}
          >
            <option value="">
              {siteId && siteEquipmentState === "loading"
                ? t.sourceLoading
                : t.selectSource}
            </option>
            {sourceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          {siteId && siteEquipmentState === "error" ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {t.sourceLoadFailed}
            </p>
          ) : null}
          {siteId &&
          siteEquipmentState === "idle" &&
          (siteEquipment?.length ?? 0) === 0 ? (
            <p className="text-sm text-steel">{t.sourceEmpty}</p>
          ) : null}
        </div>
        <Button
          type="button"
          onClick={() => void findCandidates()}
          disabled={!sourceId || searchState === "loading"}
        >
          <ArrowLeftRight aria-hidden="true" size={16} />
          {t.findCandidates}
        </Button>
      </div>

      {candidates && candidates.length === 0 ? (
        <p className="rounded-md border border-dashed border-line bg-muted-panel p-3 text-sm text-steel">
          {t.noCandidates}
        </p>
      ) : null}

      {candidates && candidates.length > 0 ? (
        <div className="grid gap-3">
          {canManage ? (
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="substitution-location"
              >
                {t.assignmentLocation}
              </label>
              <Input
                id="substitution-location"
                value={assignmentLocation}
                placeholder={t.assignmentLocationPlaceholder}
                onChange={(event) => {
                  setAssignmentLocation(event.currentTarget.value);
                }}
              />
            </div>
          ) : null}
          <div className="grid gap-0.5">
            <h3 className="text-base font-semibold text-ink">
              {t.candidatesSpareTitle}
            </h3>
            <p className="text-sm text-steel">{t.candidatesSpareHint}</p>
          </div>
          <ul className="grid gap-2">
            {candidates.map((candidate) => (
              <li
                key={candidate.equipment_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
              >
                <div className="grid gap-1">
                  <span className="font-medium text-ink">
                    {candidate.management_no ?? candidate.equipment_no}
                    {candidate.model ? ` · ${candidate.model}` : ""}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-steel">
                    <span>
                      {t.tonLabel}: {candidate.ton_text}
                      {candidate.ton_delta_milli !== null &&
                      candidate.ton_delta_milli > 0
                        ? ` (+${String(candidate.ton_delta_milli / 1000)}t ${t.tonUpgrade})`
                        : ""}
                    </span>
                    <span>
                      {t.specLabel}: {candidate.specification}
                    </span>
                    <span>
                      {t.powerLabelHeading}: {powerLabel(candidate)}
                    </span>
                  </span>
                  <span className="text-sm text-steel">
                    {candidate.customer_name} / {candidate.site_name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>
                    {candidate.match_kind === "exact_ton"
                      ? t.fullCompat
                      : matchLabel(candidate.match_kind)}
                  </Badge>
                  {canManage ? (
                    <Button
                      type="button"
                      onClick={() => void assign(candidate)}
                      disabled={
                        !assignmentLocation.trim() || assignState === "loading"
                      }
                    >
                      {assignState === "loading" ? t.assigning : t.assign}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {assignment ? (
        <div className="grid gap-3 rounded-md border border-brand-teal/30 bg-brand-teal/10 p-4">
          <h3 className="text-base font-semibold text-ink">
            {t.activeTitle}
          </h3>
          <p className="text-sm text-steel">{assignment.assignment_location}</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="substitution-return-note"
              >
                {t.returnNote}
              </label>
              <Input
                id="substitution-return-note"
                value={returnNote}
                onChange={(event) => {
                  setReturnNote(event.currentTarget.value);
                }}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void returnSubstitute()}
              disabled={returnState === "loading"}
            >
              <RotateCcw aria-hidden="true" size={16} />
              {returnState === "loading" ? t.returning : t.return}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
