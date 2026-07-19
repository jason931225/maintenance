import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../../api/client";
import { ko } from "../../../i18n/ko";
import {
  detailFixture,
  graphFixture,
  instanceFixture,
  summaryFixture,
} from "../../../test/ontologyFixtures";
import { useOntologyWorkspace } from "../_ontology/useOntologyWorkspace";
import { OntologyManagerBody } from "./OntologyManagerBody";

vi.mock("../../../api/ontology");
// Only BulkPolicyGateProvider + PolicyGated are exercised here; stub both as
// open passthroughs so the body renders without the auth/bulk-authorize round-trip.
vi.mock("../../policy", () => {
  const passthrough = ({ children }: { children: ReactNode }) => (
    <>{children}</>
  );
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
const AUTHORITY_KEY = "tenant-1|user-1||||";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function addProperty(panel: HTMLElement, title: string): void {
  fireEvent.change(within(panel).getByLabelText("속성 이름"), {
    target: { value: title },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "속성 추가" }));
}

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
    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    // The type rail lists the loaded type…
    expect((await screen.findAllByText("계약")).length).toBeGreaterThan(0);
    // …and the tablist offers both tabs.
    const tabs = screen.getByRole("tablist", { name: ko.nav.ontology });
    expect(
      within(tabs).getByRole("tab", { name: ko.ontology.tabs.manager }),
    ).toHaveAttribute("aria-selected", "true");
    // Authoring affordance present (create-type form, gates open via passthrough).
    expect(
      screen.getByLabelText(ko.console.ontology.typeList.addName),
    ).toBeInTheDocument();
  });

  it("switches to the 그래프·탐색 tab and renders the graph", async () => {
    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    await screen.findAllByText("계약");
    fireEvent.click(screen.getByRole("tab", { name: ko.ontology.tabs.graph }));
    expect(
      (await screen.findAllByText("NK보안 경비용역")).length,
    ).toBeGreaterThan(0);
  });

  it("drills the 타입 stat to the authoring tab", async () => {
    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
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
      expect(
        screen.getByRole("tab", { name: ko.ontology.tabs.manager }),
      ).toHaveAttribute("aria-selected", "true");
    });
  });

  it("renders the honest empty state when no types exist", async () => {
    mocked.listObjectTypes.mockResolvedValue([]);
    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    expect(
      await screen.findByText(ko.console.explore.labels.empty),
    ).toBeInTheDocument();
  });

  it("renders the error state with retry when the read fails", async () => {
    mocked.listObjectTypes.mockRejectedValue(new Error("boom"));
    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    expect(await screen.findByText(ko.page.loadFailed)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ko.page.retry }),
    ).toBeInTheDocument();
  });

  it("keeps rapid draft snapshots in the host until one quiescent reload", async () => {
    const draftSummary = {
      ...summaryFixture,
      lifecycle_state: "draft" as const,
    };
    mocked.listObjectTypes.mockResolvedValue([draftSummary]);
    mocked.getObjectType.mockResolvedValue({
      ...detailFixture,
      object_type: draftSummary,
    });
    const first = deferred<typeof summaryFixture>();
    const second = deferred<typeof summaryFixture>();
    mocked.stageObjectTypeRevision
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    const panel = await screen.findByRole("article", { name: "계약" });
    addProperty(panel, "담당자");
    addProperty(panel, "시작일");
    addProperty(panel, "종료일");

    expect(mocked.stageObjectTypeRevision).toHaveBeenCalledTimes(1);
    expect(mocked.listObjectTypes).toHaveBeenCalledTimes(1);
    expect(within(panel).getByText("담당자")).toBeVisible();
    expect(within(panel).getByText("시작일")).toBeVisible();
    expect(within(panel).getByText("종료일")).toBeVisible();

    await act(async () => {
      first.resolve(draftSummary);
      await first.promise;
    });
    await waitFor(() => {
      expect(mocked.stageObjectTypeRevision).toHaveBeenCalledTimes(2);
    });
    expect(mocked.listObjectTypes).toHaveBeenCalledTimes(1);

    const finalDraft = mocked.stageObjectTypeRevision.mock.calls[1]?.[2];
    expect(finalDraft.properties?.map(({ title }) => title)).toEqual([
      "월 계약금",
      "담당자",
      "시작일",
      "종료일",
    ]);

    await act(async () => {
      second.resolve(draftSummary);
      await second.promise;
    });
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledTimes(2);
    });
    expect(mocked.listObjectTypes).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rejected draft save and still persists the accumulated tail", async () => {
    const draftSummary = {
      ...summaryFixture,
      lifecycle_state: "draft" as const,
    };
    mocked.listObjectTypes.mockResolvedValue([draftSummary]);
    mocked.getObjectType.mockResolvedValue({
      ...detailFixture,
      object_type: draftSummary,
    });
    const first = deferred<typeof summaryFixture>();
    const second = deferred<typeof summaryFixture>();
    mocked.stageObjectTypeRevision
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<OntologyManagerBody api={api} authorityKey={AUTHORITY_KEY} />);
    const panel = await screen.findByRole("article", { name: "계약" });
    addProperty(panel, "담당자");
    addProperty(panel, "시작일");

    await act(async () => {
      first.reject(new Error("save failed"));
      await first.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(mocked.stageObjectTypeRevision).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      ko.users.form.saveFailed,
    );
    expect(
      mocked.stageObjectTypeRevision.mock.calls[1]?.[2].properties?.map(
        ({ title }) => title,
      ),
    ).toEqual(["월 계약금", "담당자", "시작일"]);

    await act(async () => {
      second.resolve(draftSummary);
      await second.promise;
    });
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledTimes(2);
    });
  });

  it("masks A immediately on an authority rerender and only lets loaded B persist", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aSummary = {
      ...summaryFixture,
      id: "11111111-1111-1111-1111-11111111111a",
      stable_key: "a_contract",
      title: "A 계약",
      lifecycle_state: "draft" as const,
    };
    const bSummary = {
      ...summaryFixture,
      id: "11111111-1111-1111-1111-11111111111b",
      stable_key: "b_contract",
      title: "B 계약",
      lifecycle_state: "draft" as const,
    };
    mocked.listObjectTypes.mockImplementation((client) =>
      Promise.resolve([client === apiA ? aSummary : bSummary]),
    );
    mocked.getObjectType.mockImplementation((client) =>
      Promise.resolve({
        ...detailFixture,
        object_type: client === apiA ? aSummary : bSummary,
      }),
    );
    mocked.listInstances.mockResolvedValue([]);
    mocked.getObjectTypeActing.mockResolvedValue([]);
    mocked.stageObjectTypeRevision.mockResolvedValue(bSummary);

    const view = render(
      <StrictMode>
        <OntologyManagerBody api={apiA} authorityKey="authority-a" />
      </StrictMode>,
    );
    const staleAPanel = await screen.findByRole("article", { name: "A 계약" });

    view.rerender(
      <StrictMode>
        <OntologyManagerBody api={apiB} authorityKey="authority-b" />
      </StrictMode>,
    );
    addProperty(staleAPanel, "A 유출");

    expect(
      screen.queryByRole("article", { name: "A 계약" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("속성 이름")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(ko.page.loading);
    expect(mocked.stageObjectTypeRevision).not.toHaveBeenCalled();

    const bPanel = await screen.findByRole("article", { name: "B 계약" });
    addProperty(bPanel, "B 저장");
    await waitFor(() => {
      expect(mocked.stageObjectTypeRevision).toHaveBeenCalledTimes(1);
    });
    expect(mocked.stageObjectTypeRevision).toHaveBeenCalledWith(
      apiB,
      "b_contract",
      expect.objectContaining({
        properties: expect.arrayContaining([
          expect.objectContaining({ title: "B 저장" }),
        ]),
      }),
      expect.objectContaining({
        expected: expect.any(Object),
        signal: expect.anything(),
      }),
    );
    expect(mocked.stageObjectTypeRevision).not.toHaveBeenCalledWith(
      apiB,
      "a_contract",
      expect.anything(),
      expect.anything(),
    );
    expect(
      mocked.stageObjectTypeRevision.mock.calls[0]?.[2].properties,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "A 유출" })]),
    );
  });

  it("clears an already-open local A window synchronously when B becomes current", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    mocked.getInstance.mockResolvedValue(instanceFixture);
    mocked.getInstanceHistory.mockResolvedValue([instanceFixture.revision]);

    const view = render(
      <OntologyManagerBody api={apiA} authorityKey="authority-a" />,
    );
    const panel = await screen.findByRole("article", { name: "계약" });
    fireEvent.click(
      within(panel).getByRole("tab", {
        name: ko.console.ontology.subtabs.instances,
      }),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: /개체 카드 열기$/ }),
    );
    expect(
      await screen.findByRole("region", { name: "NK보안 경비용역" }),
    ).toBeVisible();

    view.rerender(
      <OntologyManagerBody api={apiB} authorityKey="authority-b" />,
    );
    expect(
      screen.queryByRole("region", { name: "NK보안 경비용역" }),
    ).not.toBeInTheDocument();
  });

  for (const surface of ["manager instance", "graph node"] as const) {
    for (const settlement of ["resolve", "reject"] as const) {
      it(`keeps B current in StrictMode when shared-host A ${surface} ${settlement}s late`, async () => {
        const apiA = { authority: "A" } as unknown as ConsoleApiClient;
        const apiB = { authority: "B" } as unknown as ConsoleApiClient;
        const aSummary = { ...summaryFixture, title: "A 계약" };
        const bSummary = { ...summaryFixture, title: "B 계약" };
        const aDetail = { ...detailFixture, object_type: aSummary };
        const bDetail = { ...detailFixture, object_type: bSummary };
        const aInstance = {
          ...instanceFixture,
          instance: { ...instanceFixture.instance, title: "A 비밀" },
        };
        const bInstance = {
          ...instanceFixture,
          instance: { ...instanceFixture.instance, title: "B 공개" },
        };
        const aGraph = {
          ...graphFixture,
          nodes: graphFixture.nodes.map((node, index) => ({
            ...node,
            title: index === 0 ? "A 비밀" : node.title,
          })),
        };
        const bGraph = {
          ...graphFixture,
          nodes: graphFixture.nodes.map((node, index) => ({
            ...node,
            title: index === 0 ? "B 공개" : node.title,
          })),
        };
        const aRead = deferred<typeof instanceFixture>();
        mocked.listObjectTypes.mockImplementation((client) =>
          Promise.resolve([client === apiA ? aSummary : bSummary]),
        );
        mocked.getObjectType.mockImplementation((client) =>
          Promise.resolve(client === apiA ? aDetail : bDetail),
        );
        mocked.listInstances.mockImplementation((client) =>
          Promise.resolve([client === apiA ? aInstance : bInstance]),
        );
        mocked.getObjectTypeActing.mockResolvedValue([]);
        mocked.traverseInstance.mockImplementation((client) =>
          Promise.resolve(client === apiA ? aGraph : bGraph),
        );
        mocked.getInstance.mockImplementation((client) =>
          client === apiA ? aRead.promise : Promise.resolve(bInstance),
        );
        mocked.getInstanceHistory.mockResolvedValue([instanceFixture.revision]);

        const view = render(
          <StrictMode>
            <OntologyManagerBody api={apiA} authorityKey="authority-a" />
          </StrictMode>,
        );
        const aPanel = await screen.findByRole("article", { name: "A 계약" });
        if (surface === "manager instance") {
          fireEvent.click(
            within(aPanel).getByRole("tab", {
              name: ko.console.ontology.subtabs.instances,
            }),
          );
          fireEvent.click(
            within(aPanel).getByRole("button", { name: /개체 카드 열기$/ }),
          );
        } else {
          fireEvent.click(
            screen.getByRole("tab", { name: ko.ontology.tabs.graph }),
          );
        }
        await waitFor(() => {
          expect(mocked.getInstance).toHaveBeenCalledWith(
            apiA,
            instanceFixture.instance.id,
          );
        });

        view.rerender(
          <StrictMode>
            <OntologyManagerBody api={apiB} authorityKey="authority-b" />
          </StrictMode>,
        );
        if (surface === "manager instance") {
          expect(
            await screen.findByRole("article", { name: "B 계약" }),
          ).toBeInTheDocument();
        } else {
          expect((await screen.findAllByText("B 공개")).length).toBeGreaterThan(
            0,
          );
        }
        expect(screen.queryByText("A 비밀")).not.toBeInTheDocument();

        await act(async () => {
          if (settlement === "resolve") aRead.resolve(aInstance);
          else aRead.reject(new Error("A retired"));
          await aRead.promise.catch(() => undefined);
        });
        await waitFor(() => {
          expect(screen.queryByText("A 비밀")).not.toBeInTheDocument();
          expect(
            screen.getAllByText(
              surface === "manager instance" ? "B 계약" : "B 공개",
            ).length,
          ).toBeGreaterThan(0);
        });
      });
    }
  }

  it("keeps B registry and graph when A's deferred read resolves last", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aList = deferred<(typeof summaryFixture)[]>();
    const aSummary = { ...summaryFixture, title: "A 계약" };
    const bSummary = { ...summaryFixture, title: "B 계약" };
    const aDetail = { ...detailFixture, object_type: aSummary };
    const bDetail = { ...detailFixture, object_type: bSummary };
    const aInstance = {
      ...instanceFixture,
      instance: { ...instanceFixture.instance, title: "A 그래프" },
    };
    const bInstance = {
      ...instanceFixture,
      instance: { ...instanceFixture.instance, title: "B 그래프" },
    };
    const aGraph = {
      ...graphFixture,
      nodes: graphFixture.nodes.map((node, index) => ({
        ...node,
        title: index === 0 ? "A 그래프" : node.title,
      })),
    };
    const bGraph = {
      ...graphFixture,
      nodes: graphFixture.nodes.map((node, index) => ({
        ...node,
        title: index === 0 ? "B 그래프" : node.title,
      })),
    };
    mocked.listObjectTypes.mockImplementation((client) =>
      client === apiA ? aList.promise : Promise.resolve([bSummary]),
    );
    mocked.getObjectType.mockImplementation((client) =>
      Promise.resolve(client === apiA ? aDetail : bDetail),
    );
    mocked.listInstances.mockImplementation((client) =>
      Promise.resolve(client === apiA ? [aInstance] : [bInstance]),
    );
    mocked.getObjectTypeActing.mockResolvedValue([]);
    mocked.traverseInstance.mockImplementation((client) =>
      Promise.resolve(client === apiA ? aGraph : bGraph),
    );

    const view = render(
      <OntologyManagerBody api={apiA} authorityKey="authority-a" />,
    );
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledWith(apiA);
    });
    view.rerender(
      <OntologyManagerBody api={apiB} authorityKey="authority-b" />,
    );
    expect((await screen.findAllByText("B 계약")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: ko.ontology.tabs.graph }));
    expect((await screen.findAllByText("B 그래프")).length).toBeGreaterThan(0);

    await act(async () => {
      aList.resolve([aSummary]);
      await aList.promise;
    });
    expect(mocked.getObjectType).not.toHaveBeenCalledWith(
      apiA,
      expect.anything(),
    );
    expect(mocked.traverseInstance).not.toHaveBeenCalledWith(
      apiA,
      expect.anything(),
    );
    expect(screen.queryByText("A 계약")).not.toBeInTheDocument();
    expect(screen.queryByText("A 그래프")).not.toBeInTheDocument();
    expect(screen.getAllByText("B 그래프").length).toBeGreaterThan(0);
  });

  it("keeps B readable when A's deferred read rejects last", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aList = deferred<(typeof summaryFixture)[]>();
    const bSummary = { ...summaryFixture, title: "B 계약" };
    mocked.listObjectTypes.mockImplementation((client) =>
      client === apiA ? aList.promise : Promise.resolve([bSummary]),
    );
    mocked.getObjectType.mockResolvedValue({
      ...detailFixture,
      object_type: bSummary,
    });
    mocked.listInstances.mockResolvedValue([instanceFixture]);
    mocked.getObjectTypeActing.mockResolvedValue([]);
    mocked.traverseInstance.mockResolvedValue(graphFixture);

    const view = render(
      <OntologyManagerBody api={apiA} authorityKey="authority-a" />,
    );
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledWith(apiA);
    });
    view.rerender(
      <OntologyManagerBody api={apiB} authorityKey="authority-b" />,
    );
    expect((await screen.findAllByText("B 계약")).length).toBeGreaterThan(0);

    await act(async () => {
      aList.reject(new Error("A failed"));
      await aList.promise.catch(() => undefined);
    });
    expect(screen.queryByText(ko.page.loadFailed)).not.toBeInTheDocument();
    expect(screen.getAllByText("B 계약").length).toBeGreaterThan(0);
  });

  it("prevents deferred A read continuation and writes after unmount", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const aList = deferred<(typeof summaryFixture)[]>();
    mocked.listObjectTypes.mockImplementation(() => aList.promise);
    const view = render(
      <OntologyManagerBody api={apiA} authorityKey="authority-a" />,
    );
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledWith(apiA);
    });
    view.unmount();

    await act(async () => {
      aList.resolve([summaryFixture]);
      await aList.promise;
    });
    expect(mocked.getObjectType).not.toHaveBeenCalled();
    expect(mocked.listInstances).not.toHaveBeenCalled();
  });

  for (const resolverName of [
    "resolveInstanceCard",
    "resolveNodeDescriptor",
  ] as const) {
    for (const settlement of ["resolve", "reject"] as const) {
      it(`cancels stale ${resolverName} when A ${settlement}s after B is current`, async () => {
        const apiA = { authority: "A" } as unknown as ConsoleApiClient;
        const apiB = { authority: "B" } as unknown as ConsoleApiClient;
        const aSummary = { ...summaryFixture, title: "A 계약" };
        const bSummary = { ...summaryFixture, title: "B 계약" };
        const aDetail = { ...detailFixture, object_type: aSummary };
        const bDetail = { ...detailFixture, object_type: bSummary };
        const aInstance = {
          ...instanceFixture,
          instance: { ...instanceFixture.instance, title: "A 비밀" },
        };
        const bInstance = {
          ...instanceFixture,
          instance: { ...instanceFixture.instance, title: "B 공개" },
        };
        mocked.listObjectTypes.mockImplementation((client) =>
          Promise.resolve([client === apiA ? aSummary : bSummary]),
        );
        mocked.getObjectType.mockImplementation((client) =>
          Promise.resolve(client === apiA ? aDetail : bDetail),
        );
        mocked.listInstances.mockImplementation((client) =>
          Promise.resolve([client === apiA ? aInstance : bInstance]),
        );
        mocked.getObjectTypeActing.mockResolvedValue([]);
        mocked.traverseInstance.mockImplementation((client) =>
          Promise.resolve({
            ...graphFixture,
            nodes: graphFixture.nodes.map((node, index) => ({
              ...node,
              title:
                index === 0
                  ? client === apiA
                    ? "A 비밀"
                    : "B 공개"
                  : node.title,
            })),
          }),
        );
        mocked.getInstanceHistory.mockResolvedValue([instanceFixture.revision]);

        const view = renderHook(
          ({ client, authorityKey }) =>
            useOntologyWorkspace(
              client,
              { saveFailed: "save failed" },
              authorityKey,
            ),
          {
            initialProps: { client: apiA, authorityKey: "authority-a" },
            wrapper: StrictMode,
          },
        );
        await waitFor(() => {
          expect(view.result.current.readState).toBe("idle");
          expect(view.result.current.registry[0]?.title).toBe("A 계약");
        });

        const aRead = deferred<typeof instanceFixture>();
        mocked.getInstance.mockImplementation((client) =>
          client === apiA ? aRead.promise : Promise.resolve(bInstance),
        );
        const pending =
          resolverName === "resolveInstanceCard"
            ? view.result.current.resolveInstanceCard({
                id: instanceFixture.instance.id,
                code: "AAAAAAAA",
                title: "A 비밀",
                lifecycleState: "active",
              })
            : view.result.current.resolveNodeDescriptor({
                id: instanceFixture.instance.id,
                type: "contract",
                code: "AAAAAAAA",
                label: "A 비밀",
              });
        await waitFor(() => {
          expect(mocked.getInstance).toHaveBeenCalledWith(
            apiA,
            instanceFixture.instance.id,
          );
        });

        view.rerender({ client: apiB, authorityKey: "authority-b" });
        await waitFor(() => {
          expect(view.result.current.readState).toBe("idle");
          expect(view.result.current.registry[0]?.title).toBe("B 계약");
        });
        await act(async () => {
          if (settlement === "resolve") aRead.resolve(aInstance);
          else aRead.reject(new Error("A retired"));
          await expect(pending).resolves.toBeUndefined();
        });
        expect(view.result.current.registry[0]?.title).toBe("B 계약");
        expect(
          view.result.current.explorerModel.nodes.some(
            (node) => node.label === "A 비밀",
          ),
        ).toBe(false);
      });
    }
  }

  it("directly rejects a retained A commit callback after B and preserves current B persistence", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aSummary = {
      ...summaryFixture,
      title: "A 계약",
      lifecycle_state: "draft" as const,
    };
    const bSummary = {
      ...summaryFixture,
      title: "B 계약",
      lifecycle_state: "draft" as const,
    };
    mocked.listObjectTypes.mockImplementation((client) =>
      Promise.resolve([client === apiA ? aSummary : bSummary]),
    );
    mocked.getObjectType.mockImplementation((client) =>
      Promise.resolve({
        ...detailFixture,
        object_type: client === apiA ? aSummary : bSummary,
      }),
    );
    mocked.listInstances.mockResolvedValue([]);
    mocked.getObjectTypeActing.mockResolvedValue([]);
    mocked.stageObjectTypeRevision.mockResolvedValue(bSummary);

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
      expect(view.result.current.registry[0]?.title).toBe("A 계약");
    });
    const retainedACommit = view.result.current.onCommitRevision;
    const aSnapshot = view.result.current.registry[0];

    view.rerender({ client: apiB, authorityKey: "authority-b" });
    await waitFor(() => {
      expect(view.result.current.registry[0]?.title).toBe("B 계약");
    });
    await expect(retainedACommit(aSnapshot)).resolves.toBeUndefined();
    expect(mocked.stageObjectTypeRevision).not.toHaveBeenCalled();

    const bSnapshot = view.result.current.registry[0];
    await expect(
      view.result.current.onCommitRevision(bSnapshot),
    ).resolves.toBeUndefined();
    expect(mocked.stageObjectTypeRevision).toHaveBeenCalledWith(
      apiB,
      summaryFixture.stable_key,
      expect.anything(),
      expect.objectContaining({
        expected: expect.any(Object),
        signal: expect.anything(),
      }),
    );
  });

  it("invalidates callbacks through repeated authority rotations without retaining retired scopes", async () => {
    const clients = Array.from(
      { length: 12 },
      (_, index) =>
        ({
          authority: `tenant-${String(index)}`,
        }) as unknown as ConsoleApiClient,
    );
    mocked.listObjectTypes.mockResolvedValue([summaryFixture]);
    mocked.getObjectType.mockResolvedValue(detailFixture);
    mocked.listInstances.mockResolvedValue([instanceFixture]);
    mocked.getObjectTypeActing.mockResolvedValue([]);
    mocked.traverseInstance.mockResolvedValue(graphFixture);
    mocked.getInstance.mockResolvedValue(instanceFixture);
    mocked.getInstanceHistory.mockResolvedValue([instanceFixture.revision]);

    const view = renderHook(
      ({ client, authorityKey }) =>
        useOntologyWorkspace(
          client,
          { saveFailed: "save failed" },
          authorityKey,
        ),
      { initialProps: { client: clients[0], authorityKey: "authority-0" } },
    );
    const retiredResolvers: Array<
      ReturnType<typeof useOntologyWorkspace>["resolveInstanceCard"]
    > = [];
    for (let index = 0; index < clients.length; index += 1) {
      if (index > 0) {
        view.rerender({
          client: clients[index],
          authorityKey: `authority-${String(index)}`,
        });
      }
      await waitFor(() => {
        expect(view.result.current.readState).toBe("idle");
      });
      if (index < clients.length - 1)
        retiredResolvers.push(view.result.current.resolveInstanceCard);
    }
    mocked.getInstance.mockClear();
    for (const resolver of retiredResolvers) {
      await expect(
        resolver({
          id: instanceFixture.instance.id,
          code: "AAAAAAAA",
          title: "retired",
          lifecycleState: "active",
        }),
      ).resolves.toBeUndefined();
    }
    expect(mocked.getInstance).not.toHaveBeenCalled();
  });

  it("does not surface A persist feedback after switching to B", async () => {
    const apiA = { authority: "A" } as unknown as ConsoleApiClient;
    const apiB = { authority: "B" } as unknown as ConsoleApiClient;
    const aPersist = deferred<typeof summaryFixture>();
    const draftSummary = {
      ...summaryFixture,
      lifecycle_state: "draft" as const,
    };
    const bSummary = { ...summaryFixture, title: "B 계약" };
    mocked.listObjectTypes.mockImplementation((client) =>
      Promise.resolve([client === apiA ? draftSummary : bSummary]),
    );
    mocked.getObjectType.mockImplementation((client) =>
      Promise.resolve({
        ...detailFixture,
        object_type: client === apiA ? draftSummary : bSummary,
      }),
    );
    mocked.stageObjectTypeRevision.mockImplementation(() => aPersist.promise);

    const view = render(
      <OntologyManagerBody api={apiA} authorityKey="authority-a" />,
    );
    const panel = await screen.findByRole("article", { name: "계약" });
    addProperty(panel, "A 저장");
    await waitFor(() => {
      expect(mocked.stageObjectTypeRevision).toHaveBeenCalledTimes(1);
    });
    view.rerender(
      <OntologyManagerBody api={apiB} authorityKey="authority-b" />,
    );
    expect((await screen.findAllByText("B 계약")).length).toBeGreaterThan(0);

    await act(async () => {
      aPersist.reject(new Error("A save failed"));
      await aPersist.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText("B 계약").length).toBeGreaterThan(0);
  });
  it("uses the same explicit nested persistence partition across API recreation", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const apiA1 = { version: "a1" } as unknown as ConsoleApiClient;
    const apiA2 = { version: "a2" } as unknown as ConsoleApiClient;
    const view = render(
      <OntologyManagerBody api={apiA1} authorityKey="tenant-a:incarnation-a" />,
    );
    await screen.findAllByText(summaryFixture.title);

    view.rerender(
      <OntologyManagerBody api={apiA2} authorityKey="tenant-a:incarnation-a" />,
    );
    await waitFor(() => {
      expect(mocked.listObjectTypes).toHaveBeenCalledWith(apiA2);
    });

    view.rerender(
      <OntologyManagerBody api={apiA2} authorityKey="tenant-b:incarnation-b" />,
    );
    await waitFor(() => {
      const keys = getItem.mock.calls.map(([key]) => key);
      expect(keys).toContain(
        "oyatie.console.window.layout.v2.tenant-a%3Aincarnation-a",
      );
      expect(keys).toContain(
        "oyatie.console.window.layout.v2.tenant-b%3Aincarnation-b",
      );
      expect(keys).not.toContain("oyatie.console.window.layout");
    });
    getItem.mockRestore();
  });
});
