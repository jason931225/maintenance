import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../context/auth", () => ({ useAuth: () => ({ api: { GET: get, POST: post } }) }));

import { PeopleWorkforceBody } from "./PeopleWorkforceBody";

describe("PeopleWorkforceBody", () => {
  beforeEach(() => {
    get.mockImplementation((path: string) => Promise.resolve(path === "/api/v1/branches"
      ? { response: { status: 200 }, data: [{ id: "branch-1", name: "Seoul" }] }
      : { response: { status: 200 }, data: { items: [{ id: "employee-1", name: "Kim", company: "KnL" }] } }));
    post.mockResolvedValue({ response: { status: 201 }, data: { employee: { name: "Kim" } } });
  });

  it("loads actual directory data and preserves form entries after a failed create", async () => {
    post.mockResolvedValueOnce({ response: { status: 422 }, error: { message: "Invalid phone" } });
    render(<PeopleWorkforceBody />);
    await screen.findByText("Kim");
    for (const [label, value] of [["Employee number", "E-1"], ["Name", "Lee"], ["Company", "KnL"], ["Phone", "+821012345678"], ["Org unit", "HR"], ["Position", "Manager"], ["Site", "Seoul"], ["Base pay (KRW)", "100"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText("Home branch"), { target: { value: "branch-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create employee" }));
    await screen.findByText("Invalid phone");
    expect(screen.getByLabelText("Name")).toHaveValue("Lee");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/employees", expect.anything()));
  });
});
