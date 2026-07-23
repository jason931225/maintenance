import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detailFixture,
  instanceFixture,
  summaryFixture,
} from "../../../test/ontologyFixtures";
import { ApiCallError } from "../../../api/ontologyActions";
import type * as OntologyApi from "../../../api/ontology";
import { ko } from "../../../i18n/ko";
import { OntologyAnalyticsWorkbench } from "./OntologyAnalyticsWorkbench";

const A = ko.console.ontology.analysis;
const apiReads = vi.hoisted(() => ({
  listObjectTypes: vi.fn(),
  getObjectType: vi.fn(),
  listInstances: vi.fn(),
}));

vi.mock("../../../api/ontology", async (importOriginal) => {
  const actual = await importOriginal<typeof OntologyApi>();
  return {
    ...actual,
    listObjectTypes: apiReads.listObjectTypes,
    getObjectType: apiReads.getObjectType,
    listInstances: apiReads.listInstances,
  };
});

const api = {} as never;
const onClose = vi.fn();
const onDrill = vi.fn();

function contractDetail() {
  return {
    ...detailFixture,
    properties: [
      {
        ...detailFixture.properties[0],
        key: "region",
        title: "Region",
        field_type: "choice",
      },
    ],
  };
}

function record(id: string, region: string) {
  return {
    ...instanceFixture,
    instance: { ...instanceFixture.instance, id },
    revision: {
      ...instanceFixture.revision,
      id: `revision-${id}`,
      instance_id: id,
      attributes: { region },
    },
  };
}

function mount(authorityKey = "tenant-a") {
  return render(
    <>
      <button type="button">Open analysis</button>
      <OntologyAnalyticsWorkbench
        api={api}
        authorityKey={authorityKey}
        open
        onClose={onClose}
        onDrill={onDrill}
      />
    </>,
  );
}

function StatefulWorkbench() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open analysis
      </button>
      <OntologyAnalyticsWorkbench
        api={api}
        authorityKey="tenant-a"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onDrill={onDrill}
      />
    </>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OntologyAnalyticsWorkbench", () => {
  it("groups the exact authorized instances and drills to their governed IDs", async () => {
    apiReads.listObjectTypes.mockResolvedValue([summaryFixture]);
    apiReads.getObjectType.mockResolvedValue(contractDetail());
    apiReads.listInstances.mockResolvedValue([
      record("instance-a", "Seoul"),
      record("instance-b", "Seoul"),
      record("instance-c", "Busan"),
    ]);
    const user = userEvent.setup();
    mount();

    await screen.findByRole("option", { name: "Region" });
    await user.selectOptions(
      await screen.findByLabelText(A.groupBy),
      "region",
    );
    await user.click(
      await screen.findByRole("button", { name: A.openGroup("Seoul", 2) }),
    );
    expect(onDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: summaryFixture,
        dimension: "region",
        dimensionLabel: "Region",
        value: "Seoul",
        instanceIds: ["instance-a", "instance-b"],
        source: "unpaginated_instance_collection",
      }),
    );
    expect(
      screen.getByText(A.returnedCount(3)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("does not retain counts when authorization is denied", async () => {
    apiReads.listObjectTypes.mockRejectedValue(
      new ApiCallError(403, { error: "denied" }),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      A.deniedDescription,
    );
    expect(screen.queryByText(A.returnedCount(0))).not.toBeInTheDocument();
  });

  it("retries a failed read without preserving a prior result", async () => {
    apiReads.listObjectTypes
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue([summaryFixture]);
    apiReads.getObjectType.mockResolvedValue(contractDetail());
    apiReads.listInstances.mockResolvedValue([]);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: A.retry }));
    expect(
      await screen.findByText(A.noInstancesTitle),
    ).toBeInTheDocument();
  });

  it("aborts a hung request before replacing it for a new authority", async () => {
    const requests: Array<{ signal: AbortSignal; forceRefresh: boolean }> = [];
    apiReads.listObjectTypes.mockImplementation(
      (
        _api: unknown,
        options: { signal: AbortSignal; forceRefresh: boolean },
      ) => {
        requests.push(options);
        return new Promise(() => undefined);
      },
    );
    const { rerender } = mount("tenant-a");
    rerender(
      <>
        <button type="button">Open analysis</button>
        <OntologyAnalyticsWorkbench
          api={api}
          authorityKey="tenant-b"
          open
          onClose={onClose}
          onDrill={onDrill}
        />
      </>,
    );
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]).toEqual(
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1]).toEqual(
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it("fences an older authority response", async () => {
    const resolvers: Array<(value: (typeof summaryFixture)[]) => void> = [];
    apiReads.listObjectTypes.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { rerender } = mount("tenant-a");
    rerender(
      <>
        <button type="button">Open analysis</button>
        <OntologyAnalyticsWorkbench
          api={api}
          authorityKey="tenant-b"
          open
          onClose={onClose}
          onDrill={onDrill}
        />
      </>,
    );
    act(() => {
      resolvers[0]([summaryFixture]);
    });
    expect(
      screen.queryByRole("option", { name: summaryFixture.title }),
    ).not.toBeInTheDocument();
    act(() => {
      resolvers[1]([]);
    });
    await waitFor(() => {
      expect(
        screen.getByText(A.emptyTypesTitle),
      ).toBeInTheDocument();
    });
  });

  it("restores the opener after Escape closes a stateful host", async () => {
    apiReads.listObjectTypes.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<StatefulWorkbench />);
    const opener = screen.getByRole("button", { name: "Open analysis" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(opener);
  });

  it("restores the opener after Close closes a stateful host", async () => {
    apiReads.listObjectTypes.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<StatefulWorkbench />);
    const opener = screen.getByRole("button", { name: "Open analysis" });
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: A.close }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(opener);
  });
});
