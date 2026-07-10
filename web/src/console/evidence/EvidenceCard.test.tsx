import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { EvidenceCard } from "./EvidenceCard";
import { createEvidenceStubs } from "./evidenceStubs";
import type { VerifyEvidence } from "./types";

const T = ko.console.evidence;
const allowGate: PolicyGate = { can: () => true };

const [heldEvidence, plainEvidence] = createEvidenceStubs();

function renderCard(gate?: PolicyGate, verify?: VerifyEvidence, detail = heldEvidence) {
  const card = <EvidenceCard detail={detail} verify={verify} />;
  return render(gate ? <PolicyGateProvider gate={gate}>{card}</PolicyGateProvider> : card);
}

describe("EvidenceCard chips", () => {
  it("shows fixity, TSA, admissibility, and legal-hold chips", () => {
    renderCard(allowGate);
    expect(screen.getByText(/^SHA-256 /)).toBeTruthy();
    expect(screen.getByText(T.tsa.VERIFIED)).toBeTruthy();
    expect(screen.getByText(T.admissibility.ADMISSIBLE)).toBeTruthy();
    expect(screen.getByText(T.hold.active)).toBeTruthy();
  });
});

describe("EvidenceCard WORM split", () => {
  it("badges the original as immutable and lists derivatives as linked copies", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.worm.originalImmutable)).toBeTruthy();
    expect(screen.getByText(T.derivativeKinds.TRANSCODED)).toBeTruthy();
    expect(screen.getByText(T.derivativeKinds.THUMBNAIL)).toBeTruthy();
  });
});

describe("EvidenceCard custody timeline", () => {
  it("maps audit-stream actions to custody stages (수집/봉인/열람)", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.custody.stages.REGISTERED)).toBeTruthy();
    expect(screen.getByText(T.custody.stages.WORM_REPLICATED)).toBeTruthy();
    expect(screen.getByText(T.custody.stages.ACCESSED)).toBeTruthy();
  });
});

describe("EvidenceCard verify affordance", () => {
  it("calls the verify hook and surfaces the verified outcome", async () => {
    const verify = vi
      .fn<VerifyEvidence>()
      .mockResolvedValue({ state: "verified", processedAt: null });
    renderCard(allowGate, verify);
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyOk)).toBeTruthy();
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("reports 검증 대기 when no real verify path applies", async () => {
    renderCard(allowGate, undefined);
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyPending)).toBeTruthy();
    });
  });
});

describe("EvidenceCard PBAC (deny-by-omission)", () => {
  it("hides custody/hold/disposal controls without a gate (read-only persona)", () => {
    renderCard(undefined);
    expect(screen.queryByRole("button", { name: T.actions.transfer })).toBeNull();
    expect(screen.queryByRole("button", { name: T.hold.release })).toBeNull();
    expect(screen.queryByRole("button", { name: T.actions.dispose })).toBeNull();
    // verify remains available to viewers of this already-gated route.
    expect(screen.getByRole("button", { name: T.actions.verify })).toBeTruthy();
  });

  it("shows custody + hold controls for the compliance persona", () => {
    renderCard(allowGate);
    expect(screen.getByRole("button", { name: T.actions.transfer })).toBeTruthy();
    expect(screen.getByRole("button", { name: T.hold.release })).toBeTruthy();
  });
});

describe("EvidenceCard legal-hold disposal gate (fail-closed)", () => {
  it("disables disposal while a hold is active and re-enables after release", () => {
    renderCard(allowGate);
    const dispose = screen.getByRole("button", {
      name: T.actions.disposeBlockedAria,
    });
    expect(dispose.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: T.hold.release }));
    expect(
      screen.getByRole("button", { name: T.actions.dispose }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps disposal enabled when no hold exists", () => {
    renderCard(allowGate, undefined, plainEvidence);
    expect(
      screen.getByRole("button", { name: T.actions.dispose }).hasAttribute("disabled"),
    ).toBe(false);
  });
});
