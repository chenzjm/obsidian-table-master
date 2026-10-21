// @vitest-environment happy-dom
// Regression tests for the editor-paste interception entry point,
// especially the mutual exclusion with the Live Preview widget paste
// interceptor: both listen for the same paste and the widget path marks the
// event prevented first. Without the guard, the selection paste and the
// whole-table replace raced and the whole-table write clobbered the
// selection result (user-reported regression).

import { describe, expect, it, vi } from "vitest";
import TableMasterPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";

vi.mock("../ui/confirmDialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

const EXCEL_MERGED_HTML =
  '<table><tr><td colspan="2">测试</td></tr><tr><td colspan="2">测试1</td></tr></table>';

/** Minimal Editor for the interception paths (same surface as actions.test). */
class MockEditor {
  lines: string[];
  cursor: { line: number; ch: number };
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  writes: number = 0;

  constructor(lines: string[], cursor: { line: number; ch: number }, sel?: [{ line: number; ch: number }, { line: number; ch: number }]) {
    this.lines = [...lines];
    this.cursor = { ...cursor };
    [this.from, this.to] = sel ?? [cursor, cursor];
  }

  getLine(n: number): string {
    return this.lines[n] ?? "";
  }
  lineCount(): number {
    return this.lines.length;
  }
  getCursor(which?: string): { line: number; ch: number } {
    return { ...(which === "to" ? this.to : which === "from" ? this.from : this.cursor) };
  }
  transaction(spec: {
    changes?: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[];
  }): void {
    this.writes++;
    const changes = [...(spec.changes ?? [])].sort((a, b) => b.from.line - a.from.line);
    for (const ch of changes) {
      const head = this.lines[ch.from.line].slice(0, ch.from.ch);
      const tail = this.lines[ch.to.line].slice(ch.to.ch);
      const middle = ch.text.split("\n");
      const merged = [...middle.slice(0, -1), middle[middle.length - 1] + tail];
      this.lines.splice(ch.from.line, ch.to.line - ch.from.line + 1, head + merged[0], ...merged.slice(1));
    }
  }
  replaceRange(text: string, from: { line: number; ch: number }): void {
    this.writes++;
    const head = this.lines[from.line].slice(0, from.ch);
    const tail = this.lines[from.line].slice(from.ch);
    const middle = text.split("\n");
    const merged = [...middle.slice(0, -1), middle[middle.length - 1] + tail];
    this.lines.splice(from.line, 1, head + merged[0], ...merged.slice(1));
  }
  replaceSelection(_text: string): void {
    this.writes++;
  }
  text(): string {
    return this.lines.join("\n");
  }
}

const TABLE_DOC = [
  "| H1 | H2 | H3 |",
  "| --- | --- | --- |",
  "| a | b | c |",
  "| d | e | f |",
  "",
  "hello world",
];

const TWO_TABLES_DOC = [
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
  "",
  "| H3 | H4 |",
  "| --- | --- |",
  "| c | d |",
];

function makePlugin(): TableMasterPlugin {
  const plugin = Object.create(TableMasterPlugin.prototype) as TableMasterPlugin;
  (plugin as unknown as { app: unknown }).app = {};
  (plugin as unknown as { settings: unknown }).settings = { ...DEFAULT_SETTINGS };
  return plugin;
}

function fakeEvent(opts: { prevented?: boolean; html?: string; text?: string }): ClipboardEvent {
  return {
    defaultPrevented: opts.prevented ?? false,
    preventDefault() {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    clipboardData: {
      getData: (type: string) =>
        type === "text/html" ? opts.html ?? "" : type === "text/plain" ? opts.text ?? "" : "",
    },
  } as unknown as ClipboardEvent;
}

describe("handleEditorPaste mutual exclusion", () => {
  it("does nothing when the widget paste interceptor already took over (regression)", async () => {
    const plugin = makePlugin();
    const editor = new MockEditor(TABLE_DOC, { line: 2, ch: 2 });
    // Widget path marked the event prevented after handling the drag-selection.
    plugin["handleEditorPaste"](fakeEvent({ prevented: true, html: EXCEL_MERGED_HTML }), editor as never);
    await Promise.resolve(); // let any stray async tail run
    await Promise.resolve();
    expect(editor.writes).toBe(0); // no second, racing write
    expect(editor.text()).toBe(TABLE_DOC.join("\n")); // document untouched here
  });
});

describe("handleEditorPaste single-execution paths", () => {
  it("rect selection + table clipboard → exactly one write, selection-only change", async () => {
    const plugin = makePlugin();
    // Select the 2x2 block a..e (rows 1-2, cols 0-1): from inside "a" to inside "e".
    const editor = new MockEditor(
      TABLE_DOC,
      { line: 2, ch: 2 },
      [
        { line: 2, ch: 2 },
        { line: 3, ch: 5 },
      ],
    );
    plugin["handleEditorPaste"](fakeEvent({ html: EXCEL_MERGED_HTML }), editor as never);
    await new Promise((r) => setTimeout(r, 10)); // settle the full async chain
    expect(editor.writes).toBe(1);
    const text = editor.text();
    // Selection area got the pasted values; outside cells survive.
    expect(text).toContain("测试");
    expect(text).toContain("c"); // (1,2) untouched
    expect(text).toContain("f"); // (2,2) untouched
    expect(text).toContain("hello world"); // outside the table
  });

  it("no selection + table clipboard → exactly one write (insert/replace), never a racing second", async () => {
    // Deterministic async clipboard: no HTML anywhere (macOS Excel event
    // flavor), so the recovery resolves with the plain text only.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { read: vi.fn().mockResolvedValue([]) } },
    });
    const plugin = makePlugin();
    const editor = new MockEditor(TABLE_DOC, { line: 2, ch: 2 });
    // No HTML on the event (macOS Excel) → async recovery path. The text is
    // a rectangular TSV grid, which is what the synchronous gate requires.
    plugin["handleEditorPaste"](fakeEvent({ text: "测试\t列\n测试1\t列" }), editor as never);
    await new Promise((r) => setTimeout(r, 10)); // settle the full async chain
    expect(editor.writes).toBe(1);
  });

  it("no selection + non-table text clipboard → native paste, zero writes (review fix)", async () => {
    // Plain multi-line text without a tabular shape must NOT be intercepted
    // and re-simulated: the default paste flow stays untouched.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { read: vi.fn().mockResolvedValue([]) } },
    });
    const plugin = makePlugin();
    const editor = new MockEditor(TABLE_DOC, { line: 2, ch: 2 });
    const evt = fakeEvent({ text: "测试\n测试1" }); // single-column → prose, not a grid
    plugin["handleEditorPaste"](evt, editor as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(evt.defaultPrevented).toBe(false); // native paste keeps control
    expect(editor.writes).toBe(0);
    expect(editor.text()).toBe(TABLE_DOC.join("\n"));
  });
});

describe("handleEditorPaste WPS-style blocking of invalid selections", () => {
  it("cross-table selection + table clipboard → preventDefault + blocked, zero writes", async () => {
    const plugin = makePlugin();
    // from inside table 1, to inside table 2 → kind "cross".
    const editor = new MockEditor(
      TWO_TABLES_DOC,
      { line: 2, ch: 2 },
      [
        { line: 2, ch: 2 },
        { line: 6, ch: 2 },
      ],
    );
    const evt = fakeEvent({ html: EXCEL_MERGED_HTML });
    plugin["handleEditorPaste"](evt, editor as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(evt.defaultPrevented).toBe(true); // default (corrupting) paste suppressed
    expect(editor.writes).toBe(0); // document untouched; the Notice fires in the UI layer
  });

  it("selection touching a separator line + table clipboard → preventDefault + blocked, zero writes", async () => {
    const plugin = makePlugin();
    // to sits on the separator row (line 1) → kind "invalid".
    const editor = new MockEditor(
      TABLE_DOC,
      { line: 2, ch: 2 },
      [
        { line: 2, ch: 2 },
        { line: 1, ch: 5 },
      ],
    );
    const evt = fakeEvent({ html: EXCEL_MERGED_HTML });
    plugin["handleEditorPaste"](evt, editor as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(evt.defaultPrevented).toBe(true);
    expect(editor.writes).toBe(0);
  });

  it("cross-table selection + PLAIN TEXT clipboard → not intercepted (default paste harmless)", async () => {
    const plugin = makePlugin();
    const editor = new MockEditor(
      TWO_TABLES_DOC,
      { line: 2, ch: 2 },
      [
        { line: 2, ch: 2 },
        { line: 6, ch: 2 },
      ],
    );
    const evt = fakeEvent({ text: "just words" });
    plugin["handleEditorPaste"](evt, editor as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(evt.defaultPrevented).toBe(false);
    expect(editor.writes).toBe(0);
  });
});
