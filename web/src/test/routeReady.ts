import { screen } from "@testing-library/react";

export const ROUTE_LOAD_OPTIONS = { timeout: 30_000 } as const;

type RouteHeadingName = string | RegExp;
type RouteHeadingOptions = {
  level?: number;
};

export async function waitForRouteReady(
  name: RouteHeadingName,
  options: RouteHeadingOptions = { level: 1 },
) {
  return screen.findByRole(
    "heading",
    { name, ...options },
    ROUTE_LOAD_OPTIONS,
  );
}
