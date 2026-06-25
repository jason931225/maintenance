import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlatformApiError, type PlatformOrg } from "../../api/platform";
import { ForceRemoveTenantDialog } from "./ForceRemoveTenantDialog";
import { RemoveTenantDialog } from "./RemoveTenantDialog";

const archivedOrg: PlatformOrg = {
  id: "44444444-4444-4444-8444-444444444444",
  slug: "doomed-corp",
  name: "Doomed Corp",
  status: "ARCHIVED",
  created_at: "2026-03-01T00:00:00Z",
};

const activeOrg: PlatformOrg = {
  ...archivedOrg,
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-corporation",
  name: "Acme Corporation",
  status: "ACTIVE",
};

describe("ForceRemoveTenantDialog", () => {
  it("requires the exact tenant name before confirming force removal", async () => {
    const user = userEvent.setup();
    const confirmed = vi.fn(async () => {});

    render(
      <ForceRemoveTenantDialog
        org={archivedOrg}
        onConfirm={confirmed}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "테넌트와 모든 데이터 영구 삭제",
    });
    const applyButton = within(dialog).getByRole("button", {
      name: "영구 삭제",
    });
    expect(applyButton).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Doomed Corp/),
      "Doomed Corp",
    );
    expect(applyButton).toBeEnabled();
    await user.click(applyButton);

    await waitFor(() => {
      expect(confirmed).toHaveBeenCalledTimes(1);
    });
  });

  it("does not expose the destructive confirm button until the tenant is archived", () => {
    render(
      <ForceRemoveTenantDialog
        org={activeOrg}
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "테넌트와 모든 데이터 영구 삭제",
    });
    expect(
      within(dialog).queryByRole("button", { name: "영구 삭제" }),
    ).toBeNull();
    expect(
      within(dialog).getByText(
        "활성 테넌트는 영구 삭제할 수 없습니다. 먼저 이 테넌트를 보관(ARCHIVED) 처리한 뒤 다시 시도하세요.",
      ),
    ).toBeVisible();
  });

  it("reveals the force flow only after guarded removal is blocked by data", async () => {
    const user = userEvent.setup();
    const forceRequested = vi.fn();

    render(
      <RemoveTenantDialog
        org={activeOrg}
        onConfirm={() =>
          Promise.reject(new PlatformApiError(409, "tenant_has_data"))
        }
        onForceRequested={forceRequested}
        onClose={() => {}}
      />,
    );

    const guardedDialog = screen.getByRole("dialog", { name: "테넌트 삭제" });
    expect(
      within(guardedDialog).queryByRole("button", {
        name: "데이터까지 영구 삭제",
      }),
    ).toBeNull();

    await user.click(
      within(guardedDialog).getByRole("button", { name: "삭제" }),
    );
    const forceButton = await within(guardedDialog).findByRole("button", {
      name: "데이터까지 영구 삭제",
    });
    await user.click(forceButton);

    expect(forceRequested).toHaveBeenCalledTimes(1);
  });
});
