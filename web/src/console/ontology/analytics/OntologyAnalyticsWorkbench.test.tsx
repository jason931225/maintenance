import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detailFixture,
  instanceFixture,
  summaryFixture,
} from "../../../test/ontologyFixtures";
import { ApiCallError } from "../../../api/ontologyActions";
import type * as OntologyApi from "../../../api/ontology";
import { OntologyAnalyticsWorkbench } from "./OntologyAnalyticsWorkbench";

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
      await screen.findByLabelText("Group dimension"),
      "region",
    );
    await user.click(
      await screen.findByRole("button", { name: "Open Seoul, 2 records" }),
    );
    expect(onDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: summaryFixture,
        dimension: "region",
        value: "Seoul",
        instanceIds: ["instance-a", "instance-b"],
        source: "unpaginated_instance_collection",
      }),
    );
    expect(
      screen.getByText(/no pagination-total or saved-analysis contract/i),
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
      "Object types and counts are hidden",
    );
    expect(screen.queryByText(/records returned/i)).not.toBeInTheDocument();
  });

  it("retries a failed read without preserving a prior result", async () => {
    apiReads.listObjectTypes
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue([summaryFixture]);
    apiReads.getObjectType.mockResolvedValue(contractDetail());
    apiReads.listInstances.mockResolvedValue([]);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No current instances match this object type."),
    ).toBeInTheDocument();
  });

  it("fences an older authority response and restores focus on close", async () => {
    const resolvers: Array<(value: (typeof summaryFixture)[]) => void> = [];
    apiReads.listObjectTypes.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { rerender } = mount("tenant-a");
    const opener = screen.getByRole("button", { name: "Open analysis" });
    opener.focus();
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
        screen.getByText(/No authorized object types/i),
      ).toBeInTheDocument();
    });
    await userEvent.setup().keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
