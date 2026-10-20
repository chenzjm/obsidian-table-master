// End-to-end tests for the editor-level clipboard actions using a mock
// Obsidian editor: the no-selection import (replace table / insert new
// table) and the selection-aware range paste write-back. The "obsidian"
// package resolves to test/obsidian-stub.ts via vitest.config.ts.

import { describe, expect, it, vi } from "vitest";
import {
  importModelNoSelection,
  pasteModelIntoSelection,
  type ActionContext,
} from "./actions";
import { parseTable } from "../table/parser";
import type { TableModel } from "../table/model";
import { setLanguage } from "../i18n";

// The user-facing copy tests assert the zh strings (the approved spec
// format); pin the language instead of relying on the auto-detected locale.
setLanguage("zh");

vi.mock("../ui/confirmDialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true), // approve expand pastes by default
}));

/** Minimal Editor implementation covering the surface actions.ts touches. */
class MockEditor {
  lines: string[];
  cursor: { line: number; ch: number };
  lastSelection: { line: number; ch: number } | null = null;

  constructor(lines: string[], cursor: { line: number; ch: number }) {
    this.lines = [...lines];
    this.cursor = { ...cursor };
  }

  getLine(n: number): string {
    return this.lines[n] ?? "";
  }

  lineCount(): number {
    return this.lines.length;
  }

  getCursor(_from?: string): { line: number; ch: number } {
    return { ...this.cursor };
  }

  transaction(spec: {
    changes?: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[];
    selection?: { from?: { line: number; ch: number } };
  }): void {
    // Apply changes back-to-front so earlier line indexes stay valid.
    const changes = [...(spec.changes ?? [])].sort((a, b) => b.from.line - a.from.line);
    for (const ch of changes) this.splice(ch.from, ch.to, ch.text);
    if (spec.selection?.from) this.lastSelection = { ...spec.selection.from };
  }

  replaceRange(text: string, from: { line: number; ch: number }): void {
    this.splice(from, from, text);
  }

  /** Replace from..to with text (multi-line aware). */
  private splice(
    from: { line: number; ch: number },
    to: { line: number; ch: number },
    text: string,
  ): void {
    const head = this.lines[from.line].slice(0, from.ch);
    const tail = this.lines[to.line].slice(to.ch);
    const middle = text.split("\n");
    const merged = [...middle.slice(0, -1), middle[middle.length - 1] + tail];
    this.lines.splice(from.line, to.line - from.line + 1, head + merged[0], ...merged.slice(1));
  }

  text(): string {
    return this.lines.join("\n");
  }
}

function ctxFor(editor: MockEditor): ActionContext {
  return { app: {} as never, editor: editor as never, format: "gfm" as never };
}

/** "| H1 | H2 | H3 |" → col 0 starts at ch 2, col 1 at ch 7, col 2 at ch 12. */
const DOC = [
  "| H1 | H2 | H3 |",
  "| --- | --- | --- |",
  "| a | b | c |",
  "| d | e | f |",
  "",
  "hello world",
];

function modelOf(text: string): TableModel {
  return parseTable(text).model;
}

describe("importModelNoSelection (Cmd/Ctrl+V with no selection)", () => {
  it("replaces the whole table when the cursor is inside one", () => {
    const editor = new MockEditor(DOC, { line: 2, ch: 3 });
    const clip = modelOf("| X | Y |\n| --- | --- |\n| 1 | 2 |");
    const result = importModelNoSelection(ctxFor(editor), clip, "html");
    expect(result).toEqual({ kind: "replaced", source: "html" });
    // The 4 source lines of the old table are replaced by the new table,
    // the rest of the document is untouched.
    expect(editor.lines[0]).toBe("| X | Y |");
    expect(editor.lines[1]).toBe("| --- | --- |");
    expect(editor.lines[2]).toBe("| 1 | 2 |");
    expect(editor.lines[3]).toBe("");
    expect(editor.lines[4]).toBe("hello world");
  });

  it("inserts a new table after the line when the cursor is mid-line", () => {
    const editor = new MockEditor(DOC, { line: 5, ch: 5 });
    const clip = modelOf("| X | Y |\n| --- | --- |\n| 1 | 2 |");
    const result = importModelNoSelection(ctxFor(editor), clip, "tsv");
    expect(result).toEqual({ kind: "inserted", source: "tsv" });
    // The line is not split at the caret: the table follows "hello world".
    const text = editor.text();
    expect(text).toContain("hello world\n| X | Y |");
    expect(text).toContain("| 1 | 2 |");
    expect(text).not.toContain("\n world"); // no fragment behind the table
  });

  it("inserts at the cursor when it sits on an empty line", () => {
    const editor = new MockEditor(DOC, { line: 4, ch: 0 });
    const clip = modelOf("| X | Y |\n| --- | --- |\n| 1 | 2 |");
    const result = importModelNoSelection(ctxFor(editor), clip, "html");
    expect(result).toEqual({ kind: "inserted", source: "html" });
    expect(editor.lines[4]).toBe("| X | Y |");
  });
});

describe("pasteModelIntoSelection (range paste write-back)", () => {
  it("overwrites just the selected region, anchored top-left", async () => {
    const editor = new MockEditor(DOC, { line: 2, ch: 2 });
    // Select the 2x2 block a..e (rows 1-2, cols 0-1) and paste a 1-col clip
    // (clipboard models include their header row: header "NEW" + row "x").
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 2, left: 0, right: 1 };
    const result = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| NEW |\n| --- |\n| x |"),
      "html",
      sel,
    );
    expect(result.kind).toBe("pasted");
    if (result.kind !== "pasted") return;
    expect(result.rows).toBe(2); // header + one data row
    expect(result.cols).toBe(1);
    expect(result.rowsAdded).toBe(0);
    expect(result.colsAdded).toBe(0);
    // Selection size is reported alongside the pasted block size (notice).
    expect(result.selRows).toBe(2);
    expect(result.selCols).toBe(2);
    // Column 0 of the region got the clip; column 1 is untouched.
    expect(editor.lines[2]).toContain("NEW");
    expect(editor.lines[3]).toContain("x");
    expect(editor.lines[3]).toContain("f"); // (2,1) survives
    // Cursor lands on the region's top-left cell.
    expect(editor.lastSelection).not.toBeNull();
  });

  it("silently expands when a single-cell selection gets a bigger clip", async () => {
    const editor = new MockEditor(DOC, { line: 2, ch: 2 });
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 1, left: 0, right: 0 };
    const result = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |\n| 6 | 7 | 8 | 9 | 0 |"),
      "html",
      sel,
    );
    expect(result.kind).toBe("pasted");
    if (result.kind !== "pasted") return;
    expect(result.rowsAdded).toBeGreaterThan(0);
    expect(result.colsAdded).toBeGreaterThan(0);
    expect(editor.lines.length).toBe(DOC.length + result.rowsAdded!);
  });

  it("blocks a selection partially overlapping a merged cell", async () => {
    const doc = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| A | B | C |",
      "| ^^ | ^^ | D |",
    ];
    const editor = new MockEditor(doc, { line: 2, ch: 2 });
    // Rows 1-2, cols 0-1 covers the merge (A spans rows 1-2 cols 0-1) fully → allowed.
    const full = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 2, left: 0, right: 1 };
    const ok = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| X | Y |\n| --- | --- |\n| 1 | 2 |"),
      "html",
      full,
    );
    expect(ok.kind).toBe("pasted");

    // Rows 1-1 only, clip no bigger than the selection → the merge's
    // bottom half sticks out of the paste region → blocked, untouched.
    const partial = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 1, left: 0, right: 1 };
    const editor2 = new MockEditor(doc, { line: 2, ch: 2 });
    const blocked = await pasteModelIntoSelection(
      ctxFor(editor2),
      modelOf("| X | Y |\n| --- | --- |"), // 1 row x 2 cols, fits the selection
      "html",
      partial,
    );
    expect(blocked).toEqual({ kind: "blocked", reason: "partialMerge" });
    expect(editor2.text()).toBe(doc.join("\n")); // untouched
  });

  it("blocks a 1-row selection slicing a rowspan merge even with an equal clip", async () => {
    const doc = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| A | B | C |",
      "| ^^ | ^^ | D |",
    ];
    const editor = new MockEditor(doc, { line: 2, ch: 2 });
    // Selection covers row 1, cols 0-1 — but the A-merge spans rows 1-2, so
    // its lower half is outside the region. A clip that fits the selection
    // (2 cols, header row only → 1 row) must be blocked.
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 1, left: 0, right: 1 };
    const clip = modelOf("| X | Y |\n| --- | --- |"); // 1 row x 2 cols
    expect(clip.rows.length).toBe(1);
    const blocked = await pasteModelIntoSelection(ctxFor(editor), clip, "html", sel);
    expect(blocked).toEqual({ kind: "blocked", reason: "partialMerge" });
    expect(editor.text()).toBe(doc.join("\n")); // untouched
  });

  it("flattens a fully covered merge: every cell becomes a plain anchor (WPS rule)", async () => {
    const doc = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| A | B | C |",
      "| ^^ | ^^ | D |",
    ];
    const editor = new MockEditor(doc, { line: 2, ch: 2 });
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 2, left: 0, right: 1 };
    const result = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| X | Y |\n| --- | --- |\n| 1 | 2 |"),
      "html",
      sel,
    );
    expect(result.kind).toBe("pasted");
    // The 2x2 merge region is fully rewritten: placeholders gone, no `^^`.
    expect(editor.lines[2]).toContain("X");
    expect(editor.lines[3]).toContain("1");
    expect(editor.lines[3]).not.toContain("^^");
    expect(editor.text()).not.toContain("<");
  });

  it("asks for confirmation when a multi-cell selection would be expanded, with accurate sizes", async () => {
    const { confirmDialog } = await import("../ui/confirmDialog");
    const editor = new MockEditor(DOC, { line: 2, ch: 2 });
    // 2x2 selection, 3x3 clip → both dimensions expand → must ask first.
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 2, left: 0, right: 1 };
    const result = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |"),
      "html",
      sel,
    );
    expect(result.kind).toBe("pasted");
    // The dialog body must carry accurate selection AND clip sizes
    // (行/列 format from the approved spec). The clip model holds a header
    // row + 3 data rows = 4 rows.
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.anything(),
      "扩展表格",
      "剪贴板表格（4 行 × 3 列）大于选区（2 行 × 2 列），将从选区左上角粘贴并按需扩展表格。是否继续？",
      "粘贴",
    );
  });

  it("cancels without touching the document when the user declines the expansion", async () => {
    const { confirmDialog } = await import("../ui/confirmDialog");
    (confirmDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const editor = new MockEditor(DOC, { line: 2, ch: 2 });
    const sel = { kind: "rect" as const, startLine: 0, endLine: 3, top: 1, bottom: 2, left: 0, right: 1 };
    const result = await pasteModelIntoSelection(
      ctxFor(editor),
      modelOf("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |"),
      "html",
      sel,
    );
    expect(result).toEqual({ kind: "cancelled" });
    expect(editor.text()).toBe(DOC.join("\n")); // untouched
  });
});

describe("notice copy (user-facing format)", () => {
  it("importPasted renders both the pasted block and the selection sizes, 行/列 format", async () => {
    const { t } = await import("../i18n");
    const text = t("notice.importPasted", {
      rows: "3",
      cols: "1",
      selRows: "3",
      selCols: "3",
      source: "HTML",
    });
    expect(text).toBe("已将剪贴板表格（3 行 × 1 列）粘贴到选区（3 行 × 3 列）——HTML。");
  });
});
