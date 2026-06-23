import { ArrowLeftRight, RotateCcw } from "lucide-react";
import { useState } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type {
  EquipmentSummary,
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

const t = ko.equipment.substitution;

function matchLabel(kind: SubstituteCandidate["match_kind"]): string {
  return kind === "nearest_above" ? t.matchNearest : t.matchExact;
}

export function SubstitutionPanel({
  api,
  results,
  canManage,
}: SubstitutionPanelProps) {
  const [sourceId, setSourceId] = useState<string>("");
  const [candidates, setCandidates] = useState<SubstituteCandidate[]>();
  const [searchState, setSearchState] = useState<WriteState>("idle");
  const [assignmentLocation, setAssignmentLocation] = useState("");
  const [assignState, setAssignState] = useState<WriteState>("idle");
  const [assignment, setAssignment] = useState<SubstituteAssignment>();
  const [returnNote, setReturnNote] = useState("");
  const [returnState, setReturnState] = useState<WriteState>("idle");
  const [notice, setNotice] = useState<string>();

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
            onChange={(event) => {
              setSourceId(event.currentTarget.value);
              setCandidates(undefined);
              setAssignment(undefined);
            }}
          >
            <option value="">{t.selectSource}</option>
            {results.map((equipment) => (
              <option key={equipment.id} value={equipment.id}>
                {(equipment.management_no ?? equipment.equipment_no) +
                  " · " +
                  (equipment.model ?? ko.common.unknown)}
              </option>
            ))}
          </Select>
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
          <h3 className="text-base font-semibold text-ink">
            {t.candidatesTitle}
          </h3>
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
                  <span className="text-sm text-steel">
                    {candidate.ton_text} · {candidate.customer_name} /{" "}
                    {candidate.site_name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{matchLabel(candidate.match_kind)}</Badge>
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
