// Tests for ops.pasteRange — the WPS/Excel-style region paste primitive.

import { describe, expect, it } from "vitest";
import { parseTable } from "./parser";
import { serialize } from "./serializer";
import { pasteRange } from "./ops";
import { makeAnchor, makeMergeLeft, makeMergeUp, anchorOf, type TableModel } from "./model";

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

describe("pasteRange keeps MERGED clipboard cells merged (user report)", () => {
  const target = md(
    "| 测试测试1 |  |  |  |  |  |  |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |\n" +
    "| 测试 |  | 测试3 | 测试4 |  |  |  |\n" +
    "|  |  |  |  |  |  |  |\n" +
    "|  |  |  |  |  |  |  |",
  );

  it("pastes a colspan merge as a real colspan merge", () => {
    const clip = md("| A |  |\n| --- | --- |\n| X | Y |");
    // Give the clip a 2-wide merge in its header row.
    clip.rows[0][0].colspan = 2;
    clip.rows[0][1] = makeMergeLeft(1);
    const out = pasteRange(target, clip, 1, 0);
    expect(out).not.toBeNull();
    const m = out!.model;
    // Anchor keeps colspan 2; the placeholder sits at (1,1).
    expect(m.rows[1][0].colspan).toBe(2);
    expect(m.rows[1][1].isAnchor).toBe(false);
    expect(m.rows[1][1].raw).toBe("");
    expect(m.rows[1][1].anchorColOffset).toBe(1);
    // Normal cells stay plain.
    expect(m.rows[2][0].raw).toBe("X");
    expect(m.rows[2][1].raw).toBe("Y");
  });

  it("pastes a rowspan merge as a real rowspan merge", () => {
    const clip = md("| A |\n| --- |\n|  |");
    clip.rows[0][0].rowspan = 2;
    clip.rows[1][0] = makeMergeUp(1);
    const out = pasteRange(target, clip, 1, 0)!;
    expect(out.model.rows[1][0].rowspan).toBe(2);
    expect(out.model.rows[2][0].isAnchor).toBe(false);
    expect(out.model.rows[2][0].raw).toBe("^^");
  });

  it("pastes a 2x2 block merge intact", () => {
    const clip = md("| A |  |\n| --- | --- |\n|  |  |");
    clip.rows[0][0].rowspan = 2;
    clip.rows[0][0].colspan = 2;
    clip.rows[0][1] = makeMergeLeft(1);
    clip.rows[1][0] = makeMergeUp(1);
    clip.rows[1][1] = makeMergeUp(1, 1);
    const out = pasteRange(target, clip, 2, 0)!;
    const m = out.model;
    expect(m.rows[2][0].colspan).toBe(2);
    expect(m.rows[2][0].rowspan).toBe(2);
    expect(anchorOf(m, 3, 1)).toEqual({ r: 2, c: 0 });
    // Round-trip: serialize keeps the placeholders.
    const text = serialize(m, "extended");
    expect(text).toContain("<");
    expect(text).toContain("^^");
  });

  it("keeps clip merges when the paste expands the table", () => {
    // 3-row clip anchored at the last table row → the table grows by 2 rows
    // (the separator line is not a model row: the table has 2 model rows).
    const small = md("| H1 | H2 |\n| --- | --- |\n| a | b |");
    expect(small.rows.length).toBe(2);
    const clip = md("| A |  |\n| --- | --- |\n| 1 | 2 |\n| 2 |  |");
    clip.rows[2][0].colspan = 2;
    clip.rows[2][1] = makeMergeLeft(1);
    const out = pasteRange(small, clip, 1, 0)!;
    expect(out.rowsAdded).toBe(2);
    const m = out.model;
    expect(m.rows[3][0].colspan).toBe(2);
    expect(m.rows[3][1].isAnchor).toBe(false);
  });

  it("keeps the target's own merge intact while pasting a merged clip next to it", () => {
    // Target: header A spans rows 0-1 (col 0). The region starts at the last
    // model row (row 2), fully below the merge — the merge must survive.
    const withMerge = md("| A | B |\n| --- | --- |\n| x | y |\n| z | w |");
    withMerge.rows[0][0].rowspan = 2;
    withMerge.rows[1][0] = makeMergeUp(1);
    const clip = md("| P |\n| --- |\n| Q |");
    const out = pasteRange(withMerge, clip, 2, 0)!;
    expect(out.rowsAdded).toBe(1);
    expect(out.model.rows[0][0].rowspan).toBe(2);
    expect(out.model.rows[1][0].raw).toBe("^^");
    expect(out.model.rows[2][0].raw).toBe("P");
    expect(out.model.rows[3][0].raw).toBe("Q");
  });
});
