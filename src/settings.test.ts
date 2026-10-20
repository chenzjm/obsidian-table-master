// Tests for the plain-header style setting: the default (on, so pasted
// spreadsheet data keeps its original look) and the body-class toggle.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, applyPlainHeaderStyle } from "./settings";

function fakeBody(): { classes: Set<string>; classList: { toggle(cls: string, on: boolean): void } } {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      toggle(cls: string, on: boolean) {
        if (on) classes.add(cls);
        else classes.delete(cls);
      },
    },
  };
}

describe("plainHeaderStyle setting", () => {
  it("defaults to enabled (WYSIWYG for pasted data)", () => {
    expect(DEFAULT_SETTINGS.plainHeaderStyle).toBe(true);
  });

  it("toggles the tm-plain-header body class", () => {
    const body = fakeBody();
    applyPlainHeaderStyle(body, true);
    expect(body.classes.has("tm-plain-header")).toBe(true);
    applyPlainHeaderStyle(body, false);
    expect(body.classes.has("tm-plain-header")).toBe(false);
    applyPlainHeaderStyle(body, true);
    expect(body.classes.has("tm-plain-header")).toBe(true);
  });
});
