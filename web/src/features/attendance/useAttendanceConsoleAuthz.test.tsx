import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as authzModule from "../../console/policy/authz";
import type { AuthzProjection } from "../../console/policy/authz";
import { useAttendanceConsoleAuthz } from "./useAttendanceConsoleAuthz";

const mockUseAuth = vi.fn();
const mockFetchAuthzProjection =
  vi.fn<typeof authzModule.fetchAuthzProjection>();

vi.mock("../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));
vi.mock("../../console/policy/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof authzModule>();
  return {
    ...actual,
    fetchAuthzProjection: (...args: Parameters<typeof authzModule.fetchAuthzProjection>) =>
      mockFetchAuthzProjection(...args),
  };
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function projection(feature: string): AuthzProjection {
  return {
    source: "authz",
    roles: [],
    branchScope: { kind: "all" },
    capabilities: [
      {
        feature,
        permission: "allow",
        branchScope: { kind: "all" },
      },
    ],
  };
}

describe("useAttendanceConsoleAuthz", () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockFetchAuthzProjection.mockReset();
  });

  it("ignores a stale authz response after a same-incarnation token refresh", async () => {
    const oldResponse = deferred<AuthzProjection | undefined>();
    const currentResponse = deferred<AuthzProjection | undefined>();
    let session = {
      access_token: "token-a",
      client_session_incarnation: "incarnation",
      feature_grants: [],
    };
    mockUseAuth.mockImplementation(() => ({ session }));
    mockFetchAuthzProjection
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => currentResponse.promise);

    const { result, rerender } = renderHook(() => useAttendanceConsoleAuthz());
    expect(
      result.current.allows({
        feature: "employee_directory_read",
        branch: "branch-1",
        minPermission: "allow",
      }),
    ).toBe(false);

    session = { ...session, access_token: "token-b" };
    rerender();
    await waitFor(() => {
      expect(mockFetchAuthzProjection).toHaveBeenCalledTimes(2);
    });

    currentResponse.resolve(projection("employee_directory_read"));
    await waitFor(() => {
      expect(
        result.current.allows({
          feature: "employee_directory_read",
          branch: "branch-1",
          minPermission: "allow",
        }),
      ).toBe(true);
    });

    oldResponse.resolve(projection("period_lock_manage"));
    await waitFor(() => {
      expect(
        result.current.allows({
          feature: "employee_directory_read",
          branch: "branch-1",
          minPermission: "allow",
        }),
      ).toBe(true);
    });
  });

  it("withdraws cached authority immediately when a refreshed token reduces grants", async () => {
    const reducedResponse = deferred<AuthzProjection | undefined>();
    let session = {
      access_token: "token-a",
      client_session_incarnation: "incarnation",
      feature_grants: [],
    };
    mockUseAuth.mockImplementation(() => ({ session }));
    mockFetchAuthzProjection
      .mockResolvedValueOnce(projection("employee_directory_read"))
      .mockImplementationOnce(() => reducedResponse.promise);

    const { result, rerender } = renderHook(() => useAttendanceConsoleAuthz());
    await waitFor(() => {
      expect(
        result.current.allows({
          feature: "employee_directory_read",
          branch: "branch-1",
          minPermission: "allow",
        }),
      ).toBe(true);
    });

    session = { ...session, access_token: "token-b" };
    rerender();

    expect(
      result.current.allows({
        feature: "employee_directory_read",
        branch: "branch-1",
        minPermission: "allow",
      }),
    ).toBe(false);
    await waitFor(() => {
      expect(mockFetchAuthzProjection).toHaveBeenCalledTimes(2);
    });

    reducedResponse.resolve(projection("period_lock_manage"));
    await waitFor(() => {
      expect(
        result.current.allows({
          feature: "employee_directory_read",
          branch: "branch-1",
          minPermission: "allow",
        }),
      ).toBe(false);
    });
  });

  it("does not read authz while inactive and starts a fresh request on reactivation", async () => {
    mockUseAuth.mockReturnValue({
      session: {
        access_token: "token",
        client_session_incarnation: "incarnation-a",
        feature_grants: [],
      },
    });
    mockFetchAuthzProjection.mockResolvedValue(projection("employee_directory_read"));

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useAttendanceConsoleAuthz(active),
      { initialProps: { active: false } },
    );
    expect(mockFetchAuthzProjection).not.toHaveBeenCalled();

    rerender({ active: true });
    await waitFor(() => {
      expect(mockFetchAuthzProjection).toHaveBeenCalledTimes(1);
    });
  });
});
