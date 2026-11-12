import { describe, expect, it } from "vitest";

import { MIN_BANNER_COLUMNS, renderBanner, shouldShowBanner } from "../../src/cli/banner.js";

describe("renderBanner", () => {
  it("matches the snapshot", () => {
    expect(renderBanner("0.1.0")).toMatchInlineSnapshot(`
      "  .---.      .---.
        |   |------|   |
       .'              '.
       |   o        o   |     apibear v0.1.0
       |     .----.     |     Spec in. Tools out.
       |     | == |     |     OpenAPI -> MCP tools over stdio
       '.    '----'    .'
         '------------'"
    `);
  });

  it("is pure ASCII and fits within the minimum width", () => {
    const banner = renderBanner("10.20.30");
    expect(/^[\x20-\x7e\n]*$/.test(banner)).toBe(true);
    for (const line of banner.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(MIN_BANNER_COLUMNS);
    }
  });
});

describe("shouldShowBanner", () => {
  it("shows on a wide TTY", () => {
    expect(shouldShowBanner({ isTTY: true, columns: 80 })).toBe(true);
    expect(shouldShowBanner({ isTTY: true, columns: MIN_BANNER_COLUMNS })).toBe(true);
  });

  it("shows on a TTY of unknown width", () => {
    expect(shouldShowBanner({ isTTY: true })).toBe(true);
    expect(shouldShowBanner({ isTTY: true, columns: 0 })).toBe(true);
  });

  it("hides when stdout is not a TTY (piped or redirected)", () => {
    expect(shouldShowBanner({})).toBe(false);
    expect(shouldShowBanner({ isTTY: false, columns: 200 })).toBe(false);
  });

  it("hides on a narrow TTY", () => {
    expect(shouldShowBanner({ isTTY: true, columns: MIN_BANNER_COLUMNS - 1 })).toBe(false);
  });
});
