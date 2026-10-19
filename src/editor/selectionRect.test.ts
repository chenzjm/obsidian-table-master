// Tests for getSelectionRectIn — classification of editor selections for
// range pasting. Pure function over line text; no Obsidian editor needed.

import { describe, expect, it } from "vitest";
import { getSelectionRectIn, type LineSource } from "./tableLocator";

function source(lines: string[]): LineSource {
  return {
    getLine: (n: number) => lines[n] ?? "",
    lineCount: () => lines.length,
  };
}

// "| H1 | H2 | H3 |" → col 0 starts at ch 2, col 1 at ch 7, col 2 at ch 12.
const TABLE = [
  "| H1 | H2 | H3 |",
  "| --- | --- | --- |",
  "| a | b | c |",
  "| d | e | f |",
  "",
  "hello world",
];

describe("getSelectionRectIn", () => {
  it("treats a collapsed cursor as no selection", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 2, ch: 2 }, { line: 2, ch: 2 });
    expect(s.kind).toBe("none");
  });

  it("treats a selection outside any table as none", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 5, ch: 0 }, { line: 5, ch: 5 });
    expect(s.kind).toBe("none");
  });

  it("returns a single-row rect for a within-row selection", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 2, ch: 2 }, { line: 2, ch: 12 });
    expect(s.kind).toBe("rect");
    if (s.kind !== "rect") return;
    expect(s.top).toBe(1); // first body row (header is row 0)
    expect(s.bottom).toBe(1);
    expect(s.left).toBe(0);
    expect(s.right).toBe(2);
    expect(s.startLine).toBe(0);
    expect(s.endLine).toBe(3);
  });

  it("returns a rect spanning header and body rows", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 0, ch: 2 }, { line: 3, ch: 7 });
    expect(s.kind).toBe("rect");
    if (s.kind !== "rect") return;
    expect(s.top).toBe(0);
    expect(s.bottom).toBe(2);
    expect(s.left).toBe(0);
    expect(s.right).toBe(1);
  });

  it("normalizes a backwards selection", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 3, ch: 12 }, { line: 2, ch: 2 });
    expect(s.kind).toBe("rect");
    if (s.kind !== "rect") return;
    expect(s.top).toBe(1);
    expect(s.bottom).toBe(2);
    expect(s.left).toBe(0);
    expect(s.right).toBe(2);
  });

  it("flags a selection leaving the table as cross", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 2, ch: 2 }, { line: 5, ch: 2 });
    expect(s.kind).toBe("cross");
  });

  it("flags an endpoint on the separator line as invalid", () => {
    const s = getSelectionRectIn(source(TABLE), { line: 0, ch: 2 }, { line: 1, ch: 4 });
    expect(s.kind).toBe("invalid");
  });

  it("flags a selection spanning two tables as cross", () => {
    const lines = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ];
    const s = getSelectionRectIn(source(lines), { line: 0, ch: 2 }, { line: 4, ch: 2 });
    expect(s.kind).toBe("cross");
  });
});
