import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const api = { GET: get, POST: post };
vi.mock("../../context/auth", () => ({ useAuth: () => ({ api }) }));

import { PeopleWorkforceBody } from "./PeopleWorkforceBody";

function fillRequiredForm() {
  for (const [label, value] of [["사번", "E-1"], ["성명", "Lee"], ["법인", "KnL"], ["전화번호", "010-1234-5678"], ["조직", "HR"], ["직책", "Manager"], ["근무지", "Seoul"], ["기본급 (KRW)", "1,000,000"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.change(screen.getByLabelText("소속 지점"), { target: { value: "branch-1" } });
}

const detail = {
  employee: { id: "employee-1", name: "Kim", company: "KnL", employee_number: "E-1", org_unit: "HR", position: "Manager", home_branch_name: "Seoul" },
  employment: { employment_type: "REGULAR", phone_e164: "+821012345678", base_pay: "1000000", currency: "KRW" },
};

describe("PeopleWorkforceBody", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockImplementation((path: string) => Promise.resolve(path === "/api/v1/branches"
      ? { response: { status: 200 }, data: [{ id: "branch-1", name: "Seoul" }] }
      : { response: { status: 200 }, data: { items: [{ id: "employee-1", name: "Kim", company: "KnL", org_unit: "HR", position: "Manager" }] } }));
    post.mockResolvedValue({ response: { status: 201 }, data: detail });
  });

  it("normalizes Korean phone and currency input, then renders persisted privileged detail", async () => {
    render(<PeopleWorkforceBody />);
    await screen.findByText("Kim");
    fillRequiredForm();
    fireEvent.click(screen.getByRole("button", { name: "직원 등록" }));

    await screen.findByRole("heading", { name: "직원 상세" });
    expect(post).toHaveBeenCalledWith("/api/v1/employees", expect.objectContaining({
      body: expect.objectContaining({ phone: "+821012345678", base_pay: "1000000" }),
    }));
    expect(screen.getByText("+821012345678")).toBeInTheDocument();
    expect(screen.getByText("1,000,000 KRW")).toBeInTheDocument();
  });

  it("keeps one idempotency identity while a failed form is retried", async () => {
    post.mockResolvedValue({ response: { status: 422 }, error: { message: "Invalid phone" } });
    render(<PeopleWorkforceBody />);
    await screen.findByText("Kim");
    fillRequiredForm();
    fireEvent.click(screen.getByRole("button", { name: "직원 등록" }));
    await screen.findByText("Invalid phone");
    fireEvent.click(screen.getByRole("button", { name: "직원 등록" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].body.idempotency_key).toBe(post.mock.calls[0][1].body.idempotency_key);
    expect(screen.getByLabelText("성명")).toHaveValue("Lee");
  });

  it("loads actual privileged detail when an authorized directory record is opened", async () => {
    get.mockImplementation((path: string) => {
      if (path === "/api/v1/branches") return Promise.resolve({ response: { status: 200 }, data: [{ id: "branch-1", name: "Seoul" }] });
      if (path === "/api/v1/employees/{id}") return Promise.resolve({ response: { status: 200 }, data: detail });
      return Promise.resolve({ response: { status: 200 }, data: { items: [{ id: "employee-1", name: "Kim", company: "KnL" }] } });
    });
    render(<PeopleWorkforceBody />);
    await screen.findByRole("button", { name: /Kim/ });
    fireEvent.click(screen.getByRole("button", { name: /Kim/ }));
    await screen.findByText("+821012345678");
    expect(get).toHaveBeenCalledWith("/api/v1/employees/{id}", expect.anything());
  });
});
