import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ObjectViewField,
  ObjectViewPanel,
  ObjectViewProperties,
  ObjectViewScaffold,
} from "./ObjectViewScaffold";

describe("ObjectViewScaffold", () => {
  it("composes panels, descriptions and property fields", () => {
    render(
      <ObjectViewScaffold>
        <ObjectViewPanel title="Object title" description="Object summary">
          <ObjectViewProperties>
            <ObjectViewField label="Owner">Operations</ObjectViewField>
          </ObjectViewProperties>
        </ObjectViewPanel>
      </ObjectViewScaffold>,
    );

    expect(
      screen.getByRole("heading", { name: "Object title" }),
    ).toBeVisible();
    expect(screen.getByText("Object summary")).toBeVisible();
    expect(screen.getByText("Owner")).toBeVisible();
    expect(screen.getByText("Operations")).toBeVisible();
  });
});
