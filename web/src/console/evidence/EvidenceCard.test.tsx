import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiCallError } from "../../api/ontologyActions";
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

  it("clears a prior MATCH verdict chip when a later verify comes back unavailable", async () => {
    const verify = vi
      .fn<VerifyEvidence>()
      .mockResolvedValueOnce({ state: "verified", processedAt: null, copyVerdicts: new Map([["cp-13-orig", "MATCH"]]) })
      .mockResolvedValueOnce({ state: "unavailable" });
    renderCard(allowGate, verify, plainEvidence);
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.copyVerdict.MATCH)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyPending)).toBeTruthy();
    });
    // The stale green MATCH chip must be gone, not lingering as fake fixity.
    expect(screen.queryByText(T.copyVerdict.MATCH)).toBeNull();
  });

  it("shows an authorization denial without falsely claiming a fixity failure or offering a futile retry", async () => {
    const verify = vi.fn<VerifyEvidence>().mockRejectedValue(new ApiCallError(403));
    renderCard(allowGate, verify);

    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));

    await waitFor(() => {
      expect(screen.getByText(ko.page.permissionDenied)).toBeTruthy();
    });
    expect(screen.queryByText(T.actions.verifyFail)).toBeNull();
    expect(screen.getByRole("button", { name: T.actions.verify })).toBeDisabled();
  });

  it("keeps a transient verification failure retryable and replaces it with the next authoritative verdict", async () => {
    const verify = vi
      .fn<VerifyEvidence>()
      .mockRejectedValueOnce(new ApiCallError(500))
      .mockResolvedValueOnce({ state: "verified", processedAt: null, copyVerdicts: new Map([["cp-13-orig", "MATCH"]]) });
    renderCard(allowGate, verify, plainEvidence);

    const action = screen.getByRole("button", { name: T.actions.verify });
    fireEvent.click(action);
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyFail)).toBeTruthy();
    });
    expect(action).not.toBeDisabled();

    fireEvent.click(action);
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyOk)).toBeTruthy();
    });
    expect(screen.getByText(T.copyVerdict.MATCH)).toBeTruthy();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("clears a prior MATCH verdict chip when a later verify throws", async () => {
    const verify = vi
      .fn<VerifyEvidence>()
      .mockResolvedValueOnce({ state: "verified", processedAt: null, copyVerdicts: new Map([["cp-13-orig", "MATCH"]]) })
      .mockRejectedValueOnce(new Error("network"));
    renderCard(allowGate, verify, plainEvidence);
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.copyVerdict.MATCH)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: T.actions.verify }));
    await waitFor(() => {
      expect(screen.getByText(T.actions.verifyFail)).toBeTruthy();
    });
    expect(screen.queryByText(T.copyVerdict.MATCH)).toBeNull();
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

  it("keeps disposal disabled with a wire-pending reason even without a hold (no disposal REST)", () => {
    renderCard(allowGate, undefined, plainEvidence);
    expect(
      screen.getByRole("button", { name: T.actions.dispose }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(T.actions.disposeWirePending)).toBeTruthy();
  });
});

describe("EvidenceCard custody transfer / disposal (wire-pending, never fabricated)", () => {
  function custodyTimeline() {
    return screen.getByRole("region", { name: T.custody.title });
  }

  it("renders the transfer affordance disabled with a reason and stages no custody event", () => {
    renderCard(allowGate, undefined, plainEvidence);
    const transfer = screen.getByRole("button", { name: T.actions.transfer });
    expect(transfer.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(T.actions.transferWirePending)).toBeTruthy();
    // The chain-of-custody timeline shows only the real fetched events — no
    // synthetic "staged" row is ever prepended (§4-25-⑥).
    expect(within(custodyTimeline()).getAllByRole("listitem")).toHaveLength(
      plainEvidence.custody.length,
    );
    // A disabled control fires no handler; clicking never mutates state, so the
    // timeline row count stays exactly the fetched events (no staged prepend).
    fireEvent.click(transfer);
    expect(within(custodyTimeline()).getAllByRole("listitem")).toHaveLength(
      plainEvidence.custody.length,
    );
  });

  it("renders the disposal affordance disabled with a reason and stages no custody event", () => {
    renderCard(allowGate, undefined, plainEvidence);
    const dispose = screen.getByRole("button", { name: T.actions.dispose });
    expect(dispose.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(T.actions.disposeWirePending)).toBeTruthy();
    fireEvent.click(dispose);
    expect(within(custodyTimeline()).getAllByRole("listitem")).toHaveLength(
      plainEvidence.custody.length,
    );
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
