// Tests for ops.pasteRange — the WPS/Excel-style region paste primitive.

import { describe, expect, it } from "vitest";
import { parseTable } from "./parser";
import { serialize } from "./serializer";
import { pasteRange } from "./ops";
import { makeAnchor, type TableModel } from "./model";

function md(text: string): TableModel {
  return parseTable(text).model;
}

/** Build a plain clipboard grid model (what the TSV/HTML importers produce). */
function clip2(rows: string[][]): TableModel {
  const cols = rows[0].length;
  return {
    rows: rows.map((r) => r.map((txt) => makeAnchor(txt))),
    aligns: new Array(cols).fill("none"),
    headerRows: 1,
    cols,
    tbodyBreaks: [],
  };
}

const TARGET = [
  "| H1 | H2 | H3 |",
  "| --- | --- | --- |",
  "| a1 | a2 | a3 |",
  "| b1 | b2 | b3 |",
  "| c1 | c2 | c3 |",
].join("\n");

function raw(m: TableModel, r: number, c: number): string {
  return m.rows[r][c].raw;
}

describe("pasteRange", () => {
  it("pastes a smaller block anchored top-left and leaves the rest of the selection untouched", () => {
    const target = md(TARGET);
    const out = pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 1, 1)!;
    expect(out).not.toBeNull();
    expect(out.rows).toBe(2);
    expect(out.cols).toBe(2);
    expect(out.rowsAdded).toBe(0);
    expect(out.colsAdded).toBe(0);
    // Overwritten region (rows 1-2, cols 1-2)
    expect(raw(out.model, 1, 1)).toBe("X1");
    expect(raw(out.model, 1, 2)).toBe("X2");
    expect(raw(out.model, 2, 1)).toBe("Y1");
    expect(raw(out.model, 2, 2)).toBe("Y2");
    // Everything else untouched
    expect(raw(out.model, 1, 0)).toBe("a1");
    expect(raw(out.model, 2, 0)).toBe("b1");
    expect(raw(out.model, 3, 1)).toBe("c2");
    expect(raw(out.model, 0, 1)).toBe("H2");
  });

  it("overwrites the header row when the region starts there", () => {
    const target = md(TARGET);
    const out = pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 0, 0)!;
    expect(raw(out.model, 0, 0)).toBe("X1");
    expect(raw(out.model, 0, 1)).toBe("X2");
    expect(raw(out.model, 1, 0)).toBe("Y1");
    expect(raw(out.model, 1, 1)).toBe("Y2");
    expect(raw(out.model, 2, 2)).toBe("b3"); // beyond block untouched
  });

  it("expands rows and cols when the block exceeds the table bounds", () => {
    const target = md(TARGET);
    const clip = clip2([
      ["P1", "P2"],
      ["Q1", "Q2"],
      ["R1", "R2"],
      ["S1", "S2"],
    ]);
    const out = pasteRange(target, clip, 3, 2)!; // anchor at bottom-right cell
    expect(out.rowsAdded).toBe(3); // rows 4-6 appended
    expect(out.colsAdded).toBe(1); // col 3 appended
    expect(out.model.rows.length).toBe(7);
    expect(out.model.cols).toBe(4);
    expect(raw(out.model, 3, 2)).toBe("P1");
    expect(raw(out.model, 4, 2)).toBe("Q1");
    expect(raw(out.model, 5, 2)).toBe("R1");
    expect(raw(out.model, 6, 2)).toBe("S1");
    expect(raw(out.model, 6, 3)).toBe("S2");
    expect(raw(out.model, 0, 3)).toBe(""); // appended col blank outside region
    expect(out.model.aligns.length).toBe(out.model.cols);
    expect(out.model.aligns[3]).toBe("none");
  });

  it("appends columns when the block is wider than the table", () => {
    const target = md(TARGET);
    const out = pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 2, 2)!;
    expect(out.colsAdded).toBe(1);
    expect(out.rowsAdded).toBe(0);
    expect(out.model.cols).toBe(4);
    expect(raw(out.model, 2, 2)).toBe("X1");
    expect(raw(out.model, 2, 3)).toBe("X2");
    expect(raw(out.model, 3, 3)).toBe("Y2");
  });

  it("flattens merges fully covered by the region", () => {
    // a2+b2 merged vertically over rows 1-2
    const target = md(
      [
        "| H1 | H2 | H3 |",
        "| --- | --- | --- |",
        "| a1 | a2 | a3 |",
        "| b1 | ^^ | b3 |",
        "| c1 | c2 | c3 |",
      ].join("\n"),
    );
    const out = pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 1, 1)!;
    expect(out).not.toBeNull();
    expect(raw(out.model, 1, 1)).toBe("X1");
    expect(raw(out.model, 2, 1)).toBe("Y1");
    // All cells in the model are plain anchors now
    for (const r of out.model.rows) {
      for (const cell of r) expect(cell.isAnchor).toBe(true);
    }
  });

  it("rejects a merge crossing the region's bottom edge", () => {
    const target = md(
      [
        "| H1 | H2 | H3 |",
        "| --- | --- | --- |",
        "| a1 | a2 | a3 |",
        "| b1 | ^^ | b3 |",
      ].join("\n"),
    );
    // Region row 1 only, but the merge spans rows 1-2 in col 1.
    expect(pasteRange(target, clip2([["X1", "X2"]]), 1, 1)).toBeNull();
  });

  it("rejects a merge crossing the region's left edge (colspan)", () => {
    const target = md(
      [
        "| H1 | H2 | H3 |",
        "| --- | --- | --- |",
        "| a1 | < | a3 |",
        "| b1 | b2 | b3 |",
        "| c1 | c2 | c3 |",
      ].join("\n"),
    );
    expect(target.rows[1][0].colspan).toBeGreaterThan(1); // sanity: merge exists
    // Region starts at col 1 → only the right half of the merge is covered.
    expect(pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 1, 1)).toBeNull();
  });

  it("keeps merges outside the region intact", () => {
    const target = md(
      [
        "| H1 | H2 | H3 |",
        "| --- | --- | --- |",
        "| a1 | a2 | a3 |",
        "| b1 | ^^ | b3 |",
        "| c1 | c2 | c3 |",
      ].join("\n"),
    );
    const out = pasteRange(
      target,
      clip2([
        ["X1", "X2"],
        ["Y1", "Y2"],
        ["Z1", "Z2"],
      ]),
      3,
      0,
    )!;
    expect(out).not.toBeNull();
    expect(out.model.rows[2][1].isAnchor).toBe(false); // merge placeholder kept
    expect(out.model.rows[1][1].rowspan).toBe(2);
    expect(raw(out.model, 3, 0)).toBe("X1");
  });

  it("rejects an anchor outside the table", () => {
    const target = md(TARGET);
    expect(pasteRange(target, clip2([["X"]]), -1, 0)).toBeNull();
    expect(pasteRange(target, clip2([["X"]]), 0, 9)).toBeNull();
    expect(pasteRange(target, clip2([["X"]]), 99, 0)).toBeNull();
  });

  it("round-trips through the serializer", () => {
    const target = md(TARGET);
    const out = pasteRange(target, clip2([["X1", "X2"], ["Y1", "Y2"]]), 1, 1)!;
    const text = serialize(out.model, "extended");
    const reparsed = parseTable(text).model;
    expect(raw(reparsed, 1, 1)).toBe("X1");
    expect(raw(reparsed, 2, 2)).toBe("Y2");
    expect(raw(reparsed, 3, 0)).toBe("c1");
  });
});
