import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../../api/client";
import { ko } from "../../../i18n/ko";
import {
  detailFixture,
  graphFixture,
  instanceFixture,
  summaryFixture,
} from "../../../test/ontologyFixtures";
import { OntologyManagerBody } from "./OntologyManagerBody";

vi.mock("../../../api/ontology");
// Only BulkPolicyGateProvider + PolicyGated are exercised here; stub both as
// open passthroughs so the body renders without the auth/bulk-authorize round-trip.
vi.mock("../../policy", () => {
  const passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;
  // usePolicyGate is exercised by the docked ObjectCard inspector the graph pane
  // now renders; open it so the card mounts without the bulk-authorize round-trip.
  return {
    BulkPolicyGateProvider: passthrough,
    PolicyGated: passthrough,
    usePolicyGate: () => ({ can: () => true }),
  };
});

import * as ont from "../../../api/ontology";

const api = {} as ConsoleApiClient;
const mocked = vi.mocked(ont);

function seedRegistry(): void {
  mocked.listObjectTypes.mockResolvedValue([summaryFixture]);
  mocked.getObjectType.mockResolvedValue(detailFixture);
  mocked.listInstances.mockResolvedValue([instanceFixture]);
  mocked.traverseInstance.mockResolvedValue(graphFixture);
  // The 자동화 subtab read is supplementary (reload .catch-degrades it to []),
  // but the auto-mock returns undefined, which would throw on .catch — seed it.
  mocked.getObjectTypeActing.mockResolvedValue([]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OntologyManagerBody", () => {
  beforeEach(() => {
    seedRegistry();
  });

  it("defaults to the 타입·매니저 authoring tab", async () => {
    render(<OntologyManagerBody api={api} />);
    // The type rail lists the loaded type…
    expect((await screen.findAllByText("계약")).length).toBeGreaterThan(0);
    // …and the tablist offers both tabs.
    const tabs = screen.getByRole("tablist", { name: ko.nav.ontology });
    expect(within(tabs).getByRole("tab", { name: ko.ontology.tabs.manager })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Authoring affordance present (create-type form, gates open via passthrough).
    expect(screen.getByLabelText(ko.console.ontology.typeList.addName)).toBeInTheDocument();
  });

  it("switches to the 그래프·탐색 tab and renders the graph", async () => {
    render(<OntologyManagerBody api={api} />);
    await screen.findAllByText("계약");
    fireEvent.click(screen.getByRole("tab", { name: ko.ontology.tabs.graph }));
    expect((await screen.findAllByText("NK보안 경비용역")).length).toBeGreaterThan(0);
  });

  it("drills the 타입 stat to the authoring tab", async () => {
    render(<OntologyManagerBody api={api} />);
    await screen.findAllByText("계약");
    // Move to the graph tab first, then drill the 타입 stat back to the manager.
    fireEvent.click(screen.getByRole("tab", { name: ko.ontology.tabs.graph }));
    await screen.findAllByText("NK보안 경비용역");

    const strip = screen.getByRole("group", { name: ko.nav.ontology });
    fireEvent.click(
      within(strip).getByRole("button", {
        name: `${ko.console.ontology.typeList.title} ${ko.console.ontology.count(1)}`,
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: ko.ontology.tabs.manager })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("renders the honest empty state when no types exist", async () => {
    mocked.listObjectTypes.mockResolvedValue([]);
    render(<OntologyManagerBody api={api} />);
    expect(await screen.findByText(ko.console.explore.labels.empty)).toBeInTheDocument();
  });

  it("renders the error state with retry when the read fails", async () => {
    mocked.listObjectTypes.mockRejectedValue(new Error("boom"));
    render(<OntologyManagerBody api={api} />);
    expect(await screen.findByText(ko.page.loadFailed)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.page.retry })).toBeInTheDocument();
  });
});
