import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../../api/client";
import { ko } from "../../../i18n/ko";
import {
  detailFixture,
  graphFixture,
  instanceFixture,
  summaryFixture,
} from "../../../test/ontologyFixtures";
import { ExploreBody } from "./ExploreBody";

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
  // Supplementary acting read: reload .catch-degrades it, but the auto-mock
  // returns undefined which throws on .catch — seed a resolved empty list.
  mocked.getObjectTypeActing.mockResolvedValue([]);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ExploreBody", () => {
  beforeEach(() => {
    seedRegistry();
  });

  it("shows the loading state before the registry resolves", () => {
    render(<ExploreBody api={api} />);
    expect(screen.getByRole("status")).toHaveTextContent(ko.page.loading);
  });

  it("renders the graph and a drillable stat strip once loaded", async () => {
    render(<ExploreBody api={api} />);
    // The focus node title appears in the graph.
    expect((await screen.findAllByText("NK보안 경비용역")).length).toBeGreaterThan(0);

    // Stat strip: three drillable stats (타입 / 인스턴스 / 관계) — each a button.
    const strip = screen.getByRole("group", { name: ko.console.explore.title });
    const typeStat = within(strip).getByRole("button", {
      name: `${ko.console.ontology.typeList.title} ${ko.console.ontology.count(1)}`,
    });
    expect(typeStat).toHaveTextContent("1");
    expect(
      within(strip).getByRole("button", {
        name: `${ko.console.ontology.subtabs.links} ${ko.console.ontology.count(1)}`,
      }),
    ).toBeInTheDocument();

    // The explorer is read-only: no 타입·매니저 authoring tablist.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("drills from a stat without crashing (graph stays mounted)", async () => {
    render(<ExploreBody api={api} />);
    const nodes = await screen.findAllByText("NK보안 경비용역");
    const strip = screen.getByRole("group", { name: ko.console.explore.title });
    fireEvent.click(
      within(strip).getByRole("button", {
        name: `${ko.console.ontology.typeList.title} ${ko.console.ontology.count(1)}`,
      }),
    );
    expect(nodes[0]).toBeInTheDocument();
  });

  it("renders the honest empty state when the registry is empty", async () => {
    mocked.listObjectTypes.mockResolvedValue([]);
    render(<ExploreBody api={api} />);
    expect(await screen.findByText(ko.console.explore.labels.empty)).toBeInTheDocument();
  });

  it("renders the error state with retry when the read fails", async () => {
    mocked.listObjectTypes.mockRejectedValue(new Error("boom"));
    render(<ExploreBody api={api} />);
    expect(await screen.findByText(ko.page.loadFailed)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: ko.page.retry });

    // Retry re-reads: point the mock at data and click.
    seedRegistry();
    fireEvent.click(retry);
    expect((await screen.findAllByText("NK보안 경비용역")).length).toBeGreaterThan(0);
  });
  it("has no render-time API identity inference and binds nested windows to the exact authority", () => {
    const source = readFileSync(
      "src/console/screens/_ontology/OntologyWorkspaceBody.tsx",
      "utf8",
    );
    expect(source).not.toMatch(
      /readOnlyApiAuthorityIds|nextReadOnlyApiAuthorityId/,
    );
    expect(source).not.toMatch(/new WeakMap|api as object/);
    expect(source).toContain("authorityPartition={authorityPartition}");
    expect(source).toContain("key={authorityPartition}");
    expect(() =>
      renderToString(
        <ExploreBody api={api} authorityKey="tenant-a:incarnation-a" />,
      ),
    ).not.toThrow();
  });

  it("keeps StrictMode roots with the same API isolated by explicit authority partitions", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const first = render(
      <StrictMode>
        <ExploreBody api={api} authorityKey="tenant-a:incarnation-a" />
      </StrictMode>,
    );
    const second = render(
      <StrictMode>
        <ExploreBody api={api} authorityKey="tenant-a:incarnation-b" />
      </StrictMode>,
    );

    await waitFor(() => {
      const keys = getItem.mock.calls.map(([key]) => key);
      expect(keys).toContain(
        "oyatie.console.window.layout.v2.tenant-a%3Aincarnation-a",
      );
      expect(keys).toContain(
        "oyatie.console.window.layout.v2.tenant-a%3Aincarnation-b",
      );
      expect(keys).not.toContain("oyatie.console.window.layout");
    });

    first.unmount();
    second.unmount();
    getItem.mockRestore();
  });
});
