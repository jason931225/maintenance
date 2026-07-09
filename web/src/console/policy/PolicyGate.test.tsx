import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthTestProvider } from "../../test/AuthTestProvider";
import { makePolicyGate, type AuthzProjection } from "./authz";
import { PolicyGateContext, PolicyGateProvider, PolicyGated, usePolicyGate } from "./PolicyGate";

const B1 = "11111111-1111-4111-8111-111111111111";

function withProjection(projection: AuthzProjection, ui: ReactNode, ready = true) {
  return render(
    <PolicyGateContext.Provider value={makePolicyGate(projection, ready)}>
      {ui}
    </PolicyGateContext.Provider>,
  );
}

const allowRoleManage: AuthzProjection = {
  source: "authz",
  roles: ["ADMIN"],
  branchScope: { kind: "all" },
  capabilities: [{ feature: "role_manage", permission: "allow", branchScope: { kind: "all" } }],
};

describe("PolicyGated", () => {
  it("renders children when allowed", () => {
    withProjection(allowRoleManage, <PolicyGated feature="role_manage">역할 관리</PolicyGated>);
    expect(screen.getByText("역할 관리")).toBeInTheDocument();
  });

  it("renders nothing (deny-by-omission) when the feature is absent", () => {
    withProjection(allowRoleManage, <PolicyGated feature="dispatch_manage">배차</PolicyGated>);
    expect(screen.queryByText("배차")).not.toBeInTheDocument();
  });

  it("honours the fallback on deny", () => {
    withProjection(
      allowRoleManage,
      <PolicyGated feature="dispatch_manage" fallback={<span>없음</span>}>배차</PolicyGated>,
    );
    expect(screen.getByText("없음")).toBeInTheDocument();
  });

  it("denies a branch-scoped affordance outside the grant scope", () => {
    const branchScoped: AuthzProjection = {
      source: "authz",
      roles: [],
      branchScope: { kind: "branches", branches: [B1] },
      capabilities: [
        { feature: "approve", permission: "allow", branchScope: { kind: "branches", branches: [B1] } },
      ],
    };
    withProjection(
      branchScoped,
      <>
        <PolicyGated feature="approve" branch={B1}>승인</PolicyGated>
        <PolicyGated feature="approve" branch="99999999-9999-4999-8999-999999999999">타지점</PolicyGated>
      </>,
    );
    expect(screen.getByText("승인")).toBeInTheDocument();
    expect(screen.queryByText("타지점")).not.toBeInTheDocument();
  });

  it("defaults to deny-all with no provider (fail closed)", () => {
    function Probe() {
      const gate = usePolicyGate();
      return <span>{gate.allows({ feature: "role_manage" }) ? "예" : "아니오"}</span>;
    }
    render(<Probe />);
    expect(screen.getByText("아니오")).toBeInTheDocument();
  });
});


describe("PolicyGateProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function Probe() {
    const gate = usePolicyGate();
    return (
      <span data-source={gate.source} data-ready={String(gate.ready)}>
        {gate.allows({ feature: "role_manage" }) ? "allowed" : "denied"}
      </span>
    );
  }

  function okAuthz(features: string[]) {
    return {
      ok: true,
      json: () => Promise.resolve({
        capabilities: features.map((feature) => ({
          feature,
          permission: "allow",
          branch_scope: { kind: "all" },
        })),
      }),
    } as Response;
  }

  it("starts on the JWT floor and promotes to the authoritative projection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(okAuthz(["role_manage"])));
    render(
      <AuthTestProvider session={{ access_token: "t1", feature_grants: [], roles: [], org_id: "org" }}>
        <PolicyGateProvider>
          <Probe />
        </PolicyGateProvider>
      </AuthTestProvider>,
    );

    expect(screen.getByText("denied")).toHaveAttribute("data-source", "jwt-floor");
    await waitFor(() => {
      expect(screen.getByText("allowed")).toHaveAttribute("data-source", "authz");
      expect(screen.getByText("allowed")).toHaveAttribute("data-ready", "true");
    });
  });

  it("falls back to the new token floor while a stale response is ignored", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(okAuthz(["dispatch_manage"]));
    vi.stubGlobal("fetch", fetch);

    const { rerender } = render(
      <AuthTestProvider session={{ access_token: "t1", feature_grants: [], roles: [], org_id: "org" }}>
        <PolicyGateProvider>
          <Probe />
        </PolicyGateProvider>
      </AuthTestProvider>,
    );

    rerender(
      <AuthTestProvider session={{ access_token: "t2", feature_grants: ["role_manage"], roles: [], org_id: "org" }}>
        <PolicyGateProvider>
          <Probe />
        </PolicyGateProvider>
      </AuthTestProvider>,
    );

    expect(screen.getByText("allowed")).toHaveAttribute("data-source", "jwt-floor");
    resolveFirst(okAuthz(["role_manage"]));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByText("denied")).toHaveAttribute("data-source", "authz");
    });
  });
});
