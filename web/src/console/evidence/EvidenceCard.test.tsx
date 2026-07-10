import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { EvidenceCard, type EvidenceCardProps } from "./EvidenceCard";
import { evidenceFixtures } from "./evidenceFixtures";
import type { VerifyEvidence } from "./types";

const T = ko.console.evidence;
const allowGate: PolicyGate = { can: () => true };

const [heldEvidence, plainEvidence] = evidenceFixtures();

function noopHoldProps(): Pick<
  EvidenceCardProps,
  "applyHold" | "requestHoldRelease" | "decideHoldRelease" | "releaseHold"
> {
  return {
    applyHold: vi.fn().mockResolvedValue(undefined),
    requestHoldRelease: vi.fn().mockResolvedValue({ requestRef: "req-1", requestedBy: "user-a" }),
    decideHoldRelease: vi.fn().mockResolvedValue(undefined),
    releaseHold: vi.fn().mockResolvedValue(undefined),
  };
}

function renderCard(
  gate?: PolicyGate,
  verify?: VerifyEvidence,
  detail = heldEvidence,
  overrides: Partial<EvidenceCardProps> = {},
) {
  const card = (
    <EvidenceCard detail={detail} verify={verify} {...noopHoldProps()} {...overrides} />
  );
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
  it("badges the original as WORM-sealed and lists derivatives as linked copies", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.worm.sealed)).toBeTruthy();
    expect(screen.getByText(T.derivativeKinds.TRANSCODED)).toBeTruthy();
    expect(screen.getByText(T.derivativeKinds.THUMBNAIL)).toBeTruthy();
  });

  it("denies access to the original and never streams it", () => {
    renderCard(allowGate);
    fireEvent.click(screen.getByRole("button", { name: T.worm.viewOriginal }));
    expect(screen.getByRole("alert")).toHaveTextContent(T.worm.accessDenied);
  });

  it("shows the wire-pending derived-preview state on open", () => {
    renderCard(allowGate);
    fireEvent.click(screen.getAllByRole("button", { name: T.worm.viewDerived })[0]);
    expect(screen.getByText(T.worm.previewPending)).toBeTruthy();
  });
});

describe("EvidenceCard custody timeline", () => {
  it("maps wire custody stages to display labels (수집/봉인/열람)", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.custody.stages.REGISTERED)).toBeTruthy();
    expect(screen.getByText(T.custody.stages.WORM_REPLICATED)).toBeTruthy();
    expect(screen.getByText(T.custody.stages.ACCESSED)).toBeTruthy();
  });
});

describe("EvidenceCard verify affordance", () => {
  it("calls the verify hook and surfaces the verified outcome + per-copy verdicts", async () => {
    const verify = vi
      .fn<VerifyEvidence>()
      .mockResolvedValue({ state: "verified", processedAt: null, copyVerdicts: new Map([["cp-12-orig", "MATCH"]]) });
    renderCard(allowGate, verify);
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyOk)).toBeTruthy();
    });
    expect(screen.getByText(T.copyVerdict.MATCH)).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: T.hold.requestRelease })).toBeNull();
    expect(screen.queryByRole("button", { name: T.actions.dispose })).toBeNull();
    // verify remains available to viewers of this already-gated route.
    expect(screen.getByRole("button", { name: T.actions.verify })).toBeTruthy();
  });

  it("shows custody + hold controls for the compliance persona", () => {
    renderCard(allowGate);
    expect(screen.getByRole("button", { name: T.actions.transfer })).toBeTruthy();
    expect(screen.getByRole("button", { name: T.hold.requestRelease })).toBeTruthy();
  });
});

describe("EvidenceCard legal-hold disposal gate (fail-closed)", () => {
  it("disables disposal while a hold is active", () => {
    renderCard(allowGate);
    expect(
      screen.getByRole("button", { name: T.actions.disposeBlockedAria }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps disposal enabled when no hold exists", () => {
    renderCard(allowGate, undefined, plainEvidence);
    expect(
      screen.getByRole("button", { name: T.actions.dispose }).hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("EvidenceCard hold-release four-eyes flow (fail-closed)", () => {
  it("opens a pending approval, blocks a self-decide, and never releases on decide alone", async () => {
    const requestHoldRelease = vi
      .fn()
      .mockResolvedValue({ requestRef: "req-1", requestedBy: "user-a" });
    const decideHoldRelease = vi.fn().mockResolvedValue(undefined);
    const releaseHold = vi.fn().mockResolvedValue(undefined);
    renderCard(allowGate, undefined, heldEvidence, {
      currentUserId: "user-a",
      requestHoldRelease,
      decideHoldRelease,
      releaseHold,
    });

    fireEvent.click(screen.getByRole("button", { name: T.hold.requestRelease }));
    await waitFor(() => {
      expect(screen.getByText(T.hold.releasePending)).toBeTruthy();
    });
    // requestedBy === currentUserId → self-decide is blocked in the UI.
    expect(screen.getByText(T.hold.selfDecideBlocked)).toBeTruthy();
    expect(screen.queryByRole("button", { name: T.hold.decideApprove })).toBeNull();
    expect(decideHoldRelease).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("lets a distinct approver decide, then finalizes the real release call", async () => {
    const requestHoldRelease = vi
      .fn()
      .mockResolvedValue({ requestRef: "req-1", requestedBy: "user-a" });
    const decideHoldRelease = vi.fn().mockResolvedValue(undefined);
    const releaseHold = vi.fn().mockResolvedValue(undefined);
    renderCard(allowGate, undefined, heldEvidence, {
      currentUserId: "user-b",
      requestHoldRelease,
      decideHoldRelease,
      releaseHold,
    });

    fireEvent.click(screen.getByRole("button", { name: T.hold.requestRelease }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: T.hold.decideApprove })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: T.hold.decideApprove }));
    await waitFor(() => {
      expect(decideHoldRelease).toHaveBeenCalledWith("req-1", "user-a", "approved");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: T.hold.release })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: T.hold.release }));
    await waitFor(() => {
      expect(releaseHold).toHaveBeenCalledWith(
        expect.objectContaining({ holdId: "hold-12-1", fourEyesRequestRef: "req-1" }),
      );
    });
  });
});
