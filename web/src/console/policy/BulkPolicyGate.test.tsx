import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { clearAuthorizeBulkCache } from "../../api/authorizeBulk";
import { ko } from "../../i18n/ko";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { AuthSession } from "../../context/auth";
import { BulkPolicyGateProvider, PolicyGated } from "./index";

const ORG = "11111111-1111-4111-8111-111111111111";

function session(roles: string[] = ["ADMIN"]): AuthSession {
  return { access_token: "t", user_id: "u1", org_id: ORG, roles };
}

function effects(...effs: ("allow" | "deny")[]) {
  return {
    data: {
      decisions: effs.map((effect) => ({
        effect,
        determining_policies: [],
        errors: [],
        reason: "",
      })),
    },
  };
}

function mount(post: ReturnType<typeof vi.fn>, opts: { session?: AuthSession } = {}) {
  const api = { POST: post } as unknown as ConsoleApiClient;
  const ui: ReactNode = (
    <BulkPolicyGateProvider actions={["a.read"]}>
      <PolicyGated action="a.read">SECRET</PolicyGated>
    </BulkPolicyGateProvider>
  );
  const s = "session" in opts ? opts.session : session();
  return render(
    <AuthTestProvider session={s} overrides={{ api }}>
      {ui}
    </AuthTestProvider>,
  );
}

beforeEach(() => {
  clearAuthorizeBulkCache();
});

describe("BulkPolicyGateProvider", () => {
  it("hides gated affordances while the decision is pending (never optimistic)", () => {
    mount(vi.fn().mockReturnValue(new Promise(() => {}))); // never resolves
    expect(screen.queryByText("SECRET")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a gated affordance once its check resolves Allow", async () => {
    mount(vi.fn().mockResolvedValue(effects("allow")));
    await waitFor(() => {
      expect(screen.getByText("SECRET")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a gated affordance hidden when its check resolves Deny", async () => {
    const post = vi.fn().mockResolvedValue(effects("deny"));
    mount(post);
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("SECRET")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails closed on a network/HTTP error: affordance hidden + error state shown", async () => {
    mount(vi.fn().mockResolvedValue({ error: { error: { message: "down" } } }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByText("SECRET")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ko.console.policyGate.retryAria }),
    ).toBeInTheDocument();
  });

  it("fails closed with no subject (org/user absent)", () => {
    mount(vi.fn(), { session: undefined });
    expect(screen.queryByText("SECRET")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("retries after an error and shows the affordance on recovery", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ error: {} })
      .mockResolvedValueOnce(effects("allow"));
    mount(post);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: ko.console.policyGate.retryAria }));
    await waitFor(() => {
      expect(screen.getByText("SECRET")).toBeInTheDocument();
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("re-authorizes on a role change (cache invalidation)", async () => {
    const post = vi.fn().mockResolvedValue(effects("allow"));
    const api = { POST: post } as unknown as ConsoleApiClient;
    const child = (
      <BulkPolicyGateProvider actions={["a.read"]}>
        <PolicyGated action="a.read">SECRET</PolicyGated>
      </BulkPolicyGateProvider>
    );
    const { rerender } = render(
      <AuthTestProvider session={session(["ADMIN"])} overrides={{ api }}>
        {child}
      </AuthTestProvider>,
    );
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    rerender(
      <AuthTestProvider session={session(["ADMIN", "SUPER_ADMIN"])} overrides={{ api }}>
        {child}
      </AuthTestProvider>,
    );
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(2);
    });
  });
});
