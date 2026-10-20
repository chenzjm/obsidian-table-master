// Tests for the pure core of the Live Preview range paste: rectangle
// computation from resolved DOM cells and the selection-cache state
// machine. No DOM or Obsidian editor needed — see widgetSelectionCore.ts.

import { describe, expect, it } from "vitest";
import { rectFromCellInfos, WidgetSelectionCache, type CellInfo, type CachedTableSelection } from "./widgetSelectionCore";

const TABLE = {};

function cell(row: number, col: number, opts?: Partial<CellInfo>): CellInfo {
  return { table: TABLE, row, col, rows: 1, cols: 1, ...opts };
}

function sel(a: CellInfo, b: CellInfo): CachedTableSelection | null {
  const rect = rectFromCellInfos(a, b);
  return rect ? { table: a.table, rect } : null;
}

describe("rectFromCellInfos", () => {
  it("computes a rectangle for two plain cells", () => {
    const r = rectFromCellInfos(cell(1, 0), cell(2, 2));
    expect(r).toEqual({ top: 1, left: 0, bottom: 2, right: 2 });
  });

  it("normalizes a backwards (bottom-right → top-left) selection", () => {
    const r = rectFromCellInfos(cell(3, 4), cell(1, 2));
    expect(r).toEqual({ top: 1, left: 2, bottom: 3, right: 4 });
  });

  it("returns null when either end is missing", () => {
    expect(rectFromCellInfos(null, cell(0, 0))).toBeNull();
    expect(rectFromCellInfos(cell(0, 0), null)).toBeNull();
  });

  it("returns null when both ends are the same cell (in-cell text selection)", () => {
    expect(rectFromCellInfos(cell(1, 1), cell(1, 1))).toBeNull();
  });

  it("returns null when the ends live in different tables", () => {
    const a = { ...cell(1, 1), table: {} };
    const b = { ...cell(2, 2), table: {} };
    expect(rectFromCellInfos(a, b)).toBeNull();
  });

  it("expands the rectangle by a colspan merge at the selection start", () => {
    const r = rectFromCellInfos(cell(1, 0, { cols: 3 }), cell(2, 4));
    expect(r).toEqual({ top: 1, left: 0, bottom: 2, right: 4 });
  });

  it("expands the rectangle by a rowspan merge at the selection end", () => {
    const r = rectFromCellInfos(cell(0, 1), cell(2, 2, { rows: 2 }));
    expect(r).toEqual({ top: 0, left: 1, bottom: 3, right: 2 });
  });

  it("expands by merges at both ends", () => {
    const r = rectFromCellInfos(cell(0, 0, { rows: 2, cols: 2 }), cell(3, 3, { rows: 3 }));
    expect(r).toEqual({ top: 0, left: 0, bottom: 5, right: 3 });
  });

  it("treats missing spans as 1", () => {
    const r = rectFromCellInfos(cell(0, 0, { rows: 0, cols: 0 }), cell(1, 1));
    expect(r).toEqual({ top: 0, left: 0, bottom: 1, right: 1 });
  });
});

describe("WidgetSelectionCache", () => {
  const SEL_A = sel(cell(1, 1), cell(2, 3))!;
  const SEL_B = sel(cell(0, 0), cell(0, 3))!;

  it("starts empty and paste takes nothing", () => {
    const c = new WidgetSelectionCache();
    expect(c.take()).toBeNull();
  });

  it("records a selection and consumes it exactly once on paste", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    expect(c.take()).toEqual(SEL_A);
    expect(c.take()).toBeNull(); // single use
  });

  it("keeps the selection across Cmd+V (the paste itself consumes it)", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onKeydown("v", true, false, false);
    expect(c.peek()).toEqual(SEL_A);
  });

  it("keeps the selection across Ctrl+V on non-mac layouts", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onKeydown("v", false, true, false);
    expect(c.peek()).toEqual(SEL_A);
  });

  it("keeps the selection across Cmd+C (copy the drag-selection)", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onKeydown("c", true, false, false);
    expect(c.peek()).toEqual(SEL_A);
  });

  it("keeps the selection across bare modifier keydowns", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onKeydown("Meta", false, false, false);
    c.onKeydown("Shift", false, false, false);
    c.onKeydown("Alt", false, false, false);
    expect(c.peek()).toEqual(SEL_A);
  });

  it("clears on Cmd+Shift+V (paste-without-formatting means plain text)", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onKeydown("V", true, false, true);
    expect(c.peek()).toBeNull();
  });

  it("clears on typing, arrows, Esc and Enter", () => {
    for (const key of ["a", "Z", "ArrowRight", "Escape", "Enter", "Backspace", "Tab"]) {
      const c = new WidgetSelectionCache();
      c.recordSelection(SEL_A);
      c.onKeydown(key, false, false, false);
      expect(c.peek(), `key "${key}" should clear the cache`).toBeNull();
    }
  });

  it("clears on any mousedown (clicks and fresh drags both start here)", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onMouseDown();
    expect(c.peek()).toBeNull();
  });

  it("re-records after a fresh drag follows a mousedown", () => {
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.onMouseDown(); // start of a new drag — the old selection is gone
    expect(c.peek()).toBeNull();
    c.recordSelection(null); // collapsed intermediate states don't resurrect…
    expect(c.peek()).toBeNull();
    c.recordSelection(SEL_B); // …until a real new selection arrives
    expect(c.take()).toEqual(SEL_B);
  });

  it("ignores null selections (CM resets must not clear the cache)", () => {
    // This is the core regression: CodeMirror collapses the drag-selection
    // at Cmd+V time; that selectionchange must not invalidate the cache.
    const c = new WidgetSelectionCache();
    c.recordSelection(SEL_A);
    c.recordSelection(null);
    c.onKeydown("Meta", false, false, false);
    c.recordSelection(null);
    expect(c.peek()).toEqual(SEL_A);
  });
});
