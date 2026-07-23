import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const api = { GET: get, POST: post };
let session = { org_id: "org-1", user_id: "user-1", access_token: "token-1", client_session_incarnation: 1 };
vi.mock("../../context/auth", () => ({ useAuth: () => ({ api, session }) }));

import { PeopleWorkforceBody } from "./PeopleWorkforceBody";
import { PEOPLE_WORKFORCE_ROUTE } from ".";

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
    session = { org_id: "org-1", user_id: "user-1", access_token: "token-1", client_session_incarnation: 1 };
    get.mockReset();
    post.mockReset();
    get.mockImplementation((path: string) => Promise.resolve(path === "/api/v1/branches"
      ? { response: { status: 200 }, data: [{ id: "branch-1", name: "Seoul" }] }
      : { response: { status: 200 }, data: { items: [{ id: "employee-1", name: "Kim", company: "KnL", org_unit: "HR", position: "Manager" }] } }));
    post.mockResolvedValue({ response: { status: 201 }, data: detail });
  });

  it("publishes the route-ready authorized People screen contract", () => {
    expect(PEOPLE_WORKFORCE_ROUTE.screen).toBe("people");
    expect(PEOPLE_WORKFORCE_ROUTE.pathname).toBe("/console/people");
    expect(PEOPLE_WORKFORCE_ROUTE.authorization.manageFeature).toBe("employee_directory_manage");
    expect(PEOPLE_WORKFORCE_ROUTE.Component).toBe(PeopleWorkforceBody);
  });

  it("normalizes Korean +82 optional trunk zero and currency input, then renders persisted privileged detail", async () => {
    render(<PeopleWorkforceBody />);
    await screen.findByText("Kim");
    fillRequiredForm();
    fireEvent.change(screen.getByLabelText("전화번호"), { target: { value: "+82010-1234-5678" } });
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

  it("clears privileged detail synchronously when the authority context changes", async () => {
    const { rerender } = render(<PeopleWorkforceBody />);
    await screen.findByText("Kim");
    fillRequiredForm();
    fireEvent.click(screen.getByRole("button", { name: "직원 등록" }));
    await screen.findByText("+821012345678");

    session = { ...session, access_token: "token-2", client_session_incarnation: 2 };
    rerender(<PeopleWorkforceBody />);
    expect(screen.queryByText("+821012345678")).not.toBeInTheDocument();
  });
});
