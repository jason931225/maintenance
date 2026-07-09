import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { makePolicyGate, type AuthzProjection } from "./authz";
import { PolicyGateContext, PolicyGated, usePolicyGate } from "./PolicyGate";

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
