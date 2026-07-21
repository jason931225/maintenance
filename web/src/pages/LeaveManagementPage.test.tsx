import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { leaveManagementKo as copy } from "../i18n/hrWorkflows";
import { LeaveManagementPage } from "./LeaveManagementPage";

vi.mock("../console/screens/leave/LeaveBody", () => ({
  LeaveBody: () => <div data-testid="authoritative-leave-body" />,
}));

describe("LeaveManagementPage", () => {
  it("delegates the legacy route to the authoritative leave body", () => {
    render(<LeaveManagementPage />);
    expect(screen.getByRole("heading", { name: copy.title })).toBeVisible();
    expect(screen.getByTestId("authoritative-leave-body")).toBeVisible();
  });
});
