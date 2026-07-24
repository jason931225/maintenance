import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { OntologyManagerBody } from "../ontology-manager/OntologyManagerBody";
import { useOntologyWorkspace } from "./useOntologyWorkspace";

vi.mock("../../../api/ontology");
vi.mock("../../policy", () => {
  const passthrough = ({ children }: { children: ReactNode }) => (
    <>{children}</>
  );
  return {
    BulkPolicyGateProvider: passthrough,
    PolicyGated: passthrough,
    usePolicyGate: () => ({ can: () => true }),
  };
});

import * as ont from "../../../api/ontology";

const mocked = vi.mocked(ont);
const api = {} as ConsoleApiClient;
const AUTHORITY_KEY = "tenant-1|user-1||||";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function seedRequiredReads(): void {
  mocked.listObjectTypes.mockResolvedValue([summaryFixture]);
  mocked.getObjectType.mockResolvedValue(detailFixture);
  mocked.listInstances.mockResolvedValue([instanceFixture]);
  mocked.getObjectTypeActing.mockResolvedValue([]);
  mocked.traverseInstance.mockResolvedValue(graphFixture);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ontology workspace partial read failures", () => {
  beforeEach(() => {
    seedRequiredReads();
  });

  it("distinguishes an acting-read failure from a successful empty registry", async () => {
    mocked.getObjectTypeActing.mockRejectedValue(new Error("acting denied"));
    const failed = renderHook(() =>
      useOntologyWorkspace(api, { saveFailed: "save failed" }, AUTHORITY_KEY),
    );

    await waitFor(() => {
      expect(failed.result.current.readState).toBe("idle");
    });
    expect(failed.result.current.isEmpty).toBe(false);
    expect(failed.result.current.registry).toHaveLength(1);
    expect(failed.result.current.partialFailures).toEqual([
      {
        kind: "acting",
        scopeId: summaryFixture.id,
        scopeLabel: summaryFixture.title,
      },
    ]);
    failed.unmount();

    vi.clearAllMocks();
    mocked.listObjectTypes.mockResolvedValue([]);
    const empty = renderHook(() =>
      useOntologyWorkspace(api, { saveFailed: "save failed" }, AUTHORITY_KEY),
    );
    await waitFor(() => {
      expect(empty.result.current.readState).toBe("idle");
    });
    expect(empty.result.current.isEmpty).toBe(true);
    expect(empty.result.current.partialFailures).toEqual([]);
    expect(mocked.getObjectTypeActing).not.toHaveBeenCalled();
  });

  it("keeps successful registry data visible, names both degraded reads, and retries them", async () => {
    mocked.getObjectTypeActing
      .mockRejectedValueOnce(new Error("acting unavailable"))
      .mockResolvedValueOnce([]);
    mocked.traverseInstance
      .mockRejectedValueOnce(new Error("traversal unavailable"))
      .mockResolvedValueOnce(graphFixture);

    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);

    expect(
      await screen.findByRole("article", { name: summaryFixture.title }),
    ).toBeVisible();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ko.page.loadFailed);
    expect(alert).toHaveTextContent(
      `${summaryFixture.title} · ${ko.console.ontology.subtabs.automations}`,
    );
    expect(alert).toHaveTextContent(
      `${instanceFixture.instance.title} · ${ko.ontology.tabs.graph}`,
    );

    fireEvent.click(screen.getByRole("button", { name: ko.page.retry }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(mocked.getObjectTypeActing).toHaveBeenCalledTimes(2);
    expect(mocked.traverseInstance).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("article", { name: summaryFixture.title }),
    ).toBeVisible();
  });

  it("does not let a retired authority's partial retry replace the current authority", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aSummary = { ...summaryFixture, title: "A 계약" };
    const bSummary = { ...summaryFixture, title: "B 계약" };
    const aRetry =
      deferred<Awaited<ReturnType<typeof ont.getObjectTypeActing>>>();

    mocked.listObjectTypes.mockImplementation((client) =>
      Promise.resolve([client === apiA ? aSummary : bSummary]),
    );
    mocked.getObjectType.mockImplementation((client) =>
      Promise.resolve({
        ...detailFixture,
        object_type: client === apiA ? aSummary : bSummary,
      }),
    );
    mocked.listInstances.mockResolvedValue([instanceFixture]);
    mocked.traverseInstance.mockResolvedValue(graphFixture);
    mocked.getObjectTypeActing.mockImplementationOnce(() =>
      Promise.reject(new Error("A acting unavailable")),
    );

    const view = renderHook(
      ({ client, authorityKey }) =>
        useOntologyWorkspace(
          client,
          { saveFailed: "save failed" },
          authorityKey,
        ),
      { initialProps: { client: apiA, authorityKey: "authority-a" } },
    );
    await waitFor(() => {
      expect(view.result.current.partialFailures).toHaveLength(1);
    });

    mocked.getObjectTypeActing.mockImplementation((client) =>
      client === apiA ? aRetry.promise : Promise.resolve([]),
    );
    const retiredRetry = view.result.current.retryPartialFailures();
    await waitFor(() => {
      expect(mocked.getObjectTypeActing).toHaveBeenCalledTimes(2);
    });
    view.rerender({ client: apiB, authorityKey: "authority-b" });
    await waitFor(() => {
      expect(view.result.current.readState).toBe("idle");
      expect(view.result.current.registry[0]?.title).toBe("B 계약");
      expect(view.result.current.partialFailures).toEqual([]);
    });

    await act(async () => {
      aRetry.resolve([
        { id: "a-secret", label: "A secret", kind: "automation" },
      ]);
      await retiredRetry;
    });
    expect(view.result.current.registry[0]?.title).toBe("B 계약");
    expect(view.result.current.registry[0]?.acting).toEqual([]);
    expect(view.result.current.partialFailures).toEqual([]);
  });

  it("fences a stale API client's instance-card response after the client is replaced", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const lateState = deferred<InstanceStateWire>();
    mocked.getInstance.mockImplementation((client) =>
      client === apiA ? lateState.promise : Promise.resolve(instanceFixture),
    );
    mocked.getInstanceHistory.mockResolvedValue([]);
    mocked.traverseInstance.mockResolvedValue(graphFixture);
    const view = renderHook(
      ({ client }) =>
        useOntologyWorkspace(client, { saveFailed: "save failed" }, AUTHORITY_KEY),
      { initialProps: { client: apiA } },
    );
    await waitFor(() => {
      expect(view.result.current.readState).toBe("idle");
    });

    const staleDescriptor = view.result.current.resolveInstanceCard({
      id: instanceFixture.instance.id,
      code: "A",
      title: "stale",
      lifecycleState: "active",
    });
    view.rerender({ client: apiB });
    await act(async () => {
      lateState.resolve(instanceFixture);
      await expect(staleDescriptor).resolves.toBeUndefined();
    });
  });
});
