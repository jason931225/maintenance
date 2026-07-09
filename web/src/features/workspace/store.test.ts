import { beforeEach, describe, expect, it } from "vitest";

import {
  isWorkspaceOwnerCurrent,
  runForWorkspaceOwner,
  selectScreenPanels,
  useWorkspaceStore,
} from "./store";
import type { PinnedObject } from "./types";

const wo: PinnedObject = {
  kind: "workOrder",
  code: "WO-1",
  title: "작업 1",
  fields: [],
};
const at: PinnedObject = {
  kind: "attendance",
  code: "AT-1",
  title: "출근",
  fields: [],
};

beforeEach(() => {
  useWorkspaceStore.setState({
    ownerKey: null,
    panels: [],
    hydrated: false,
    saveEnabled: false,
    snapPreview: null,
    draggingId: null,
  });
});

describe("useWorkspaceStore", () => {
  it("hydrate replaces panels and flips the hydrated flag", () => {
    useWorkspaceStore
      .getState()
      .hydrate([
        {
          id: "work-hub:workOrder:WO-1",
          screen: "work-hub",
          object: wo,
          area: "right",
          mode: "pinned",
        },
      ]);
    const state = useWorkspaceStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.panels).toHaveLength(1);
  });

  it("resets transient and persisted workspace state when the owner changes", () => {
    const store = useWorkspaceStore.getState();
    store.resetForOwner("org-a:user-a");
    store.pin("work-hub", wo);
    store.setDragging("work-hub:workOrder:WO-1");
    store.setSnapPreview("right");

    expect(isWorkspaceOwnerCurrent("org-a:user-a")).toBe(true);
    expect(
      runForWorkspaceOwner("org-b:user-b", () => {
        store.pin("attendance", at);
      }),
    ).toBe(false);
    expect(useWorkspaceStore.getState().panels).toHaveLength(1);

    store.resetForOwner("org-b:user-b");

    const state = useWorkspaceStore.getState();
    expect(state.ownerKey).toBe("org-b:user-b");
    expect(state.panels).toEqual([]);
    expect(state.hydrated).toBe(false);
    expect(state.saveEnabled).toBe(false);
    expect(state.draggingId).toBeNull();
    expect(state.snapPreview).toBeNull();
    expect(isWorkspaceOwnerCurrent("org-a:user-a")).toBe(false);
    expect(
      runForWorkspaceOwner("org-b:user-b", () => {
        state.pin("attendance", at);
      }),
    ).toBe(true);
    expect(useWorkspaceStore.getState().panels).toHaveLength(1);
  });

  it("pin / minimize / restore / close flow through the store", () => {
    const store = useWorkspaceStore.getState();
    store.pin("work-hub", wo);
    expect(useWorkspaceStore.getState().panels[0].mode).toBe("pinned");
    store.minimize("work-hub:workOrder:WO-1");
    expect(useWorkspaceStore.getState().panels[0].mode).toBe("minimized");
    store.restore("work-hub:workOrder:WO-1");
    expect(useWorkspaceStore.getState().panels[0].mode).toBe("pinned");
    store.close("work-hub:workOrder:WO-1");
    expect(useWorkspaceStore.getState().panels).toHaveLength(0);
  });

  it("selectScreenPanels isolates each screen's panels", () => {
    const store = useWorkspaceStore.getState();
    store.pin("work-hub", wo);
    store.pin("attendance", at);
    const { panels } = useWorkspaceStore.getState();
    expect(selectScreenPanels(panels, "work-hub")).toHaveLength(1);
    expect(selectScreenPanels(panels, "attendance")[0].object.code).toBe(
      "AT-1",
    );
  });

  it("restoreDefault clears only the target screen", () => {
    const store = useWorkspaceStore.getState();
    store.pin("work-hub", wo);
    store.pin("attendance", at);
    store.restoreDefault("work-hub");
    const { panels } = useWorkspaceStore.getState();
    expect(panels).toHaveLength(1);
    expect(panels[0].screen).toBe("attendance");
  });

  it("tracks transient drag preview state", () => {
    const store = useWorkspaceStore.getState();
    store.setDragging("work-hub:workOrder:WO-1");
    store.setSnapPreview("right");
    expect(useWorkspaceStore.getState().draggingId).toBe(
      "work-hub:workOrder:WO-1",
    );
    expect(useWorkspaceStore.getState().snapPreview).toBe("right");
  });
});
