import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ObjectLink } from "./ObjectLink";

describe("ObjectLink", () => {
  it("uses a human-safe label instead of leaking raw object ids", () => {
    render(
      <MemoryRouter>
        <ObjectLink
          to="/equipment/44444444-4444-4444-8444-444444444444"
          objectTypeLabel="장비"
          objectLabel="44444444-4444-4444-8444-444444444444"
          fallbackLabel="장비 미확인"
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "장비: 장비 미확인" });
    expect(link).toHaveTextContent("장비 미확인");
    expect(link).not.toHaveTextContent("44444444-4444-4444-8444-444444444444");
  });
});
