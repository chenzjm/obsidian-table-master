// @vitest-environment happy-dom
// End-to-end DOM tests for the Live Preview widget paste flow: a real DOM
// table inside a fake CM view, real selectionchange/keydown/paste events,
// and the real WidgetPasteController — the closest thing to Obsidian's Live
// Preview without launching the app. These exist because the drag-select →
// copy → paste flow regressed twice while only unit-tested.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WidgetPasteController, type WidgetPasteView } from "./widgetPaste";
import type { ActionContext, ClipboardImportResult } from "./actions";

vi.mock("../ui/confirmDialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

const DOC_LINES = [
  "| H1 | H2 | H3 |",
  "| --- | --- | --- |",
  "| a | b | c |",
  "| d | e | f |",
  "",
  "hello world",
];

/** CM-line-height approximation for posAtDOM: line index * 100. */
function makeView(doc: Document, docLines: string[] = DOC_LINES): { view: WidgetPasteView; root: HTMLElement } {
  const root = doc.createElement("div");
  root.className = "cm-editor";
  doc.body.appendChild(root);
  const view: WidgetPasteView = {
    dom: root,
    posAtDOM: (node: Node) => {
      // Walk up to the line container; every "line" div holds one source line.
      let el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
      let lineIdx = 0;
      while (el && el.parentElement !== root) {
        const parent = el.parentElement;
        if (!parent) break;
        lineIdx = Array.prototype.indexOf.call(parent.children, el);
        el = parent;
      }
      return Math.max(0, lineIdx) * 100;
    },
    state: {
      doc: {
        lineAt: (pos: number) => ({ number: Math.floor(pos / 100) + 1 }),
        line: (n: number) => ({ text: docLines[n - 1] ?? "" }),
        length: docLines.length * 100,
        lines: docLines.length,
      },
    },
  };
  return { view, root };
}

/** Build the Live-Preview-like DOM: line divs, the table in line 0..3. */
function buildTableDom(root: HTMLElement, doc: Document): { cellA: HTMLElement; cellF: HTMLElement } {
  const mk = (cls: string, text: string) => {
    const el = doc.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const lines = DOC_LINES.map((_text) => mk("cm-line", ""));
  // Line 0..3 host the table widget (a real <table> like Obsidian renders).
  const table = doc.createElement("table");
  const rows = [
    ["H1", "H2", "H3"],
    ["a", "b", "c"],
    ["d", "e", "f"],
  ];
  const cells: Record<string, HTMLElement> = {};
  rows.forEach((r) => {
    const tr = doc.createElement("tr");
    r.forEach((text) => {
      const td = doc.createElement("td");
      td.textContent = text;
      cells[text] = td;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  lines[2].appendChild(table);
  lines.forEach((l) => root.appendChild(l));
  return { cellA: cells["a"], cellF: cells["f"] };
}

/** Editor mock that records writes into DOC_LINES (same as other suites). */
function makeEditor(lines: string[] = [...DOC_LINES]) {
  return {
    lines,
    writes: 0,
    getCursor: () => ({ line: 2, ch: 2 }),
    getLine: (n: number) => lines[n] ?? "",
    lineCount: () => lines.length,
    transaction(spec: { changes?: { from: { line: number }; to: { line: number }; text: string }[] }) {
      this.writes++;
      const changes = [...(spec.changes ?? [])].sort((a, b) => b.from.line - a.from.line);
      for (const ch of changes) {
        const middle = ch.text.split("\n");
        lines.splice(ch.from.line, ch.to.line - ch.from.line + 1, ...middle);
      }
    },
    replaceRange(text: string) {
      this.writes++;
      lines.push(text);
    },
    replaceSelection(text: string) {
      this.writes++;
      this.lastReplaced = text;
    },
    lastReplaced: "",
    text: () => lines.join("\n"),
  };
}

function makeController(view: WidgetPasteView, editor: ReturnType<typeof makeEditor>) {
  const results: ClipboardImportResult[] = [];
  const controller = new WidgetPasteController(view, {
    getActionContext: (): ActionContext => ({ app: {} as never, editor: editor as never, format: "extended" }),
    onResult: (r) => results.push(r),
    onFallbackError: () => results.push({ kind: "failed" } as ClipboardImportResult),
  });
  return { controller, results };
}

const EXCEL_HTML = '<table><tr><td>X1</td><td>X2</td></tr><tr><td>Y1</td><td>Y2</td></tr></table>';

describe("user report: drag across EMPTY cells collapses the rectangle (6x1 instead of 6x5)", () => {
  // The real document from the report: 6 rows × 7 columns, rendered FLAT
  // (no rowSpan/colSpan — the plugin ships no merge renderer), almost all
  // cells EMPTY. A DOM text selection can only anchor at text nodes, so the
  // drag from (0,0) to (5,4) collapsed to the last column holding text →
  // the dialog said "6 行 × 1 列" while the user had boxed 5 columns.
  function buildSparseTable(doc: Document) {
    const wrap = doc.createElement("div");
    wrap.className = "cm-line";
    const table = doc.createElement("table");
    const row = (cells: string[], head = false) => {
      const tr = doc.createElement("tr");
      for (const text of cells) {
        const el = doc.createElement(head ? "th" : "td");
        if (text) el.textContent = text;
        tr.appendChild(el);
      }
      table.appendChild(tr);
    };
    row(["测试测试1", "<", "", "", "", "", ""], true);
    row(["测试", "<", "测试3", "测试4", "", "", ""]);
    row(["", "", "测试", "测试", "", "", ""]);
    row(["", "", "", "", "", "", "测试"]);
    row(["", "", "", "", "", "", "测试"]);
    row(["", "", "", "", "", "", ""]);
    wrap.appendChild(table);
    return { wrap, table };
  }

  it("mouse drag from (0,0) to an EMPTY cell (5,4) → rect 6 rows × 5 cols, 4×5 clip pastes at the anchor", async () => {
    const doc = window.document;
    doc.body.innerHTML = "";
    // CM document mirrors the sparse 7-column table the user really has.
    const sparseLines = [
      "| 测试测试1 | < |  |  |  |  |  |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| 测试 | < | 测试3 | 测试4 |  |  |  |",
      "|  |  | 测试 | 测试 |  |  |  |",
      "|  |  |  |  |  |  | 测试 |",
      "|  |  |  |  |  |  | 测试 |",
    ];
    const { view, root } = makeView(doc, sparseLines);
    const { wrap, table } = buildSparseTable(doc);
    root.appendChild(wrap);

    const editor = makeEditor(sparseLines);
    const made = makeController(view, editor);

    const th00 = table.querySelector("th") as HTMLTableCellElement; // (0,0)
    const tds = table.querySelectorAll("td");
    const endEmpty = tds[7 * 4 + 4] as HTMLTableCellElement; // table row 5 (data row 4), col 4 — EMPTY

    // Mouse drag: down on the first header cell, up over the empty cell.
    th00.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
    const hit = vi.spyOn(doc, "elementFromPoint").mockReturnValue(endEmpty);
    doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 200, clientY: 150 }));
    hit.mockRestore();
    // The browser finalizes the text selection only AFTER mouseup: the DOM
    // selection stays collapsed on column 0 (empty cells cannot anchor it)
    // and its selectionchange would record the WRONG 6×1 rectangle…
    const sel = window.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(th00.firstChild!);
    sel?.removeAllRanges();
    sel?.addRange(range);
    const lastTd = tds[0] as HTMLTableCellElement; // row 0 col 0 — text exists here
    sel?.extend(lastTd.firstChild!, 1);
    doc.dispatchEvent(new Event("selectionchange"));
    // …but the geometric 6×5 rectangle has priority at paste time.

    const clip4x5 =
      "<table><tr><td>A1</td><td>A2</td><td>A3</td><td>A4</td><td>A5</td></tr>" +
      "<tr><td>B1</td><td>B2</td><td>B3</td><td>B4</td><td>B5</td></tr>" +
      "<tr><td>C1</td><td>C2</td><td>C3</td><td>C4</td><td>C5</td></tr>" +
      "<tr><td>D1</td><td>D2</td><td>D3</td><td>D4</td><td>D5</td></tr></table>";
    firePaste(doc, doc.body, { html: clip4x5 });
    await new Promise((r) => setTimeout(r, 10));

    expect(made.results[0]).toMatchObject({ kind: "pasted", rows: 4, cols: 5, selRows: 6, selCols: 5 });
    const text = editor.text();
    expect(text).toContain("A1");
    expect(text).toContain("D5"); // bottom-right of the clip landed at (3,4)
  });

  it("plain CLICK (down+up on the same cell) records nothing — normal editing unaffected", async () => {
    const doc = window.document;
    doc.body.innerHTML = "";
    const { view, root } = makeView(doc);
    const { table } = buildSparseTable(doc);
    root.appendChild(table);

    const editor = makeEditor();
    const made = makeController(view, editor);
    const td = table.querySelector("th") as HTMLTableCellElement;
    const hit = vi.spyOn(doc, "elementFromPoint").mockReturnValue(td);

    td.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
    doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 5 }));
    hit.mockRestore();
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));

    // Single-cell "drag" is not a selection → interceptor stands down.
    expect(made.results).toHaveLength(0);
    expect(editor.writes).toBe(0);
  });
});

describe("user report: multi-column selection, notice always says one column", () => {
  it("3×3 drag-selection + 1-column clipboard → rect must be 3×3, paste covers the first column only, result rows=3 cols=1", async () => {
    const doc = window.document;
    doc.body.innerHTML = "";
    const srcLines = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| a | b | c |",
      "| d | e | f |",
      "| g | h | i |",
      "",
      "hello world",
    ];
    const { view, root } = makeView(doc, srcLines);
    const lines = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| a | b | c |",
      "| d | e | f |",
      "| g | h | i |",
      "",
      "hello world",
    ].map(() => {
      const el = doc.createElement("div");
      el.className = "cm-line";
      return el;
    });
    const table = doc.createElement("table");
    table.innerHTML =
      "<tr><th>H1</th><th>H2</th><th>H3</th></tr>" +
      "<tr><td>a</td><td>b</td><td>c</td></tr>" +
      "<tr><td>d</td><td>e</td><td>f</td></tr>" +
      "<tr><td>g</td><td>h</td><td>i</td></tr>";
    lines[2].appendChild(table);
    lines.forEach((l) => root.appendChild(l));

    const editor = makeEditor();
    editor.lines = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| a | b | c |",
      "| d | e | f |",
      "| g | h | i |",
      "",
      "hello world",
    ];
    const made = makeController(view, editor);

    const tds = table.querySelectorAll("td, th");
    const first = tds[3] as HTMLElement; // a (row1 col0)
    const last = tds[11] as HTMLElement; // i (row3 col2)
    // Drag a → i: a 3×3 selection.
    const sel = window.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(first.firstChild!);
    sel?.removeAllRanges();
    sel?.addRange(range);
    sel?.extend(last.firstChild!, 1);
    doc.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("selectionchange"));

    // Clipboard holds a single 3-row column (like the user's 测试/测试1 tests).
    const evt = doc.createEvent("Event");
    evt.initEvent("paste", true, true);
    Object.defineProperty(evt, "clipboardData", {
      value: { getData: (t: string) => (t === "text/html" ? '<table><tr><td>P1</td></tr><tr><td>P2</td></tr><tr><td>P3</td></tr></table>' : "") },
    });
    (evt as unknown as { preventDefault(): void }).preventDefault = () => {};
    doc.body.dispatchEvent(evt);
    await new Promise((r) => setTimeout(r, 10));

    expect(made.results[0]).toMatchObject({ kind: "pasted", rows: 3, cols: 1 });
    const text = editor.text();
    // Column 1 overwritten, columns 2–3 untouched (partial-overlap WPS rule).
    expect(text).toMatch(/\|\s*P1\s*\|\s*b\s*\|\s*c\s*\|/);
    expect(text).toMatch(/\|\s*P2\s*\|\s*e\s*\|\s*f\s*\|/);
    expect(text).toMatch(/\|\s*P3\s*\|\s*h\s*\|\s*i\s*\|/);
  });
});

function firePaste(doc: Document, target: HTMLElement, opts: { html?: string; text?: string; prevented?: boolean }): ClipboardEvent {
  const evt = doc.createEvent("Event");
  evt.initEvent("paste", true, true);
  Object.defineProperty(evt, "clipboardData", {
    value: {
      getData: (type: string) =>
        type === "text/html" ? opts.html ?? "" : type === "text/plain" ? opts.text ?? "" : "",
    },
  });
  Object.defineProperty(evt, "defaultPrevented", {
    get(this: { __prevented?: boolean }) {
      return opts.prevented === true || this.__prevented === true;
    },
  });
  (evt as unknown as { preventDefault(): void }).preventDefault = function (this: { __prevented?: boolean }) {
    this.__prevented = true;
  };
  target.dispatchEvent(evt);
  return evt as ClipboardEvent;
}

function fireKey(doc: Document, target: HTMLElement, key: string, meta = false): void {
  const evt = doc.createEvent("Event");
  evt.initEvent("keydown", true, true);
  Object.defineProperties(evt, {
    key: { value: key },
    metaKey: { value: meta },
    ctrlKey: { value: false },
    shiftKey: { value: false },
  });
  target.dispatchEvent(evt);
}

/** Simulate a drag selection from one cell's text to another's. */
function dragSelect(doc: Document, win: Window, from: HTMLElement, to: HTMLElement): void {
  const sel = win.getSelection();
  const range = doc.createRange();
  range.selectNodeContents(from.firstChild!);
  sel?.removeAllRanges();
  sel?.addRange(range);
  sel?.extend(to.firstChild!, 1);
  doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("selectionchange"));
}

describe("Live Preview widget paste — end to end (DOM events)", () => {
  let doc: Document;
  let win: Window;
  let controller: WidgetPasteController;
  let editor: ReturnType<typeof makeEditor>;
  let results: ClipboardImportResult[];
  let cellA: HTMLElement;
  let cellF: HTMLElement;

  beforeEach(() => {
    doc = window.document;
    win = window;
    doc.body.innerHTML = "";
    // Isolate the async clipboard per test: default read yields nothing.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { read: vi.fn().mockResolvedValue([]), readText: vi.fn().mockResolvedValue("") } },
    });
    const { view, root } = makeView(doc);
    const dom = buildTableDom(root, doc);
    cellA = dom.cellA;
    cellF = dom.cellF;
    editor = makeEditor();
    const made = makeController(view, editor);
    controller = made.controller;
    results = made.results;
  });

  /** Replace the active controller (tests that build a custom DOM). */
  function rebuild(view: WidgetPasteView, ed: ReturnType<typeof makeEditor>) {
    controller.destroy(); // never leak the document-level listeners
    const made = makeController(view, ed);
    controller = made.controller;
    results = made.results;
    editor = ed;
  }

  afterEach(() => {
    controller.destroy();
    win.getSelection()?.removeAllRanges();
  });

  it("user flow: drag-select → copy in Excel → Cmd+V → replaces ONLY the selection (HTML on event)", async () => {
    dragSelect(doc, win, cellA, cellF); // 2x2 block a..f
    fireKey(doc, doc.body, "Meta", true); // bare Cmd down
    fireKey(doc, doc.body, "v", true); // Cmd+V
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));

    const text = editor.text();
    expect(editor.writes).toBe(1);
    expect(results[0]).toMatchObject({ kind: "pasted" });
    // Selection area replaced with pasted values.
    expect(text).toContain("X1");
    expect(text).toContain("Y2");
    // Cells OUTSIDE the selection survive (column padding may vary).
    expect(text).toMatch(/\|\s*c\s*\|/);
    expect(text).toMatch(/\|\s*H1\s*\|/);
    expect(text).toContain("hello world");
  });

  it("user flow (macOS Excel): no HTML on the event, async recovery → still selection-only", async () => {
    dragSelect(doc, win, cellA, cellF);
    // System clipboard returns the rich flavor asynchronously.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          read: vi.fn().mockResolvedValue([
            {
              types: ["text/html", "text/plain"],
              getType: (type: string) => ({
                text: () => Promise.resolve(type === "text/html" ? EXCEL_HTML : "X1\tX2\nY1\tY2"),
              }),
            },
          ]),
        },
      },
    });
    fireKey(doc, doc.body, "Meta", true);
    fireKey(doc, doc.body, "v", true);
    firePaste(doc, doc.body, { text: "X1\tX2\nY1\tY2" });
    await new Promise((r) => setTimeout(r, 20));

    expect(editor.writes).toBe(1);
    expect(results[0]).toMatchObject({ kind: "pasted" });
    const text = editor.text();
    expect(text).toContain("X1");
    expect(text).toMatch(/\|\s*c\s*\|/); // outside cell survives
    expect(text).toContain("hello world");
  });

  it("stray mousedown after drag-select (selection still intact) → paste still targets the selection (robustness fix)", async () => {
    dragSelect(doc, win, cellA, cellF);
    // User clicks somewhere that does NOT disturb the DOM selection
    // (e.g. re-focusing the window after copying in Excel).
    doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("mousedown", { bubbles: true }));
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));

    // The live DOM selection at paste time wins over the cleared cache.
    expect(results[0]).toMatchObject({ kind: "pasted" });
    expect(editor.text()).toContain("X1");
  });

  it("selection actually destroyed before paste (collapsed) → stand down (editor-paste owns the no-selection path)", async () => {
    dragSelect(doc, win, cellA, cellF);
    // The click moved the caret: selection collapses, cache already cleared
    // by the mousedown.
    win.getSelection()?.removeAllRanges();
    doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("mousedown", { bubbles: true }));
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));

    expect(editor.writes).toBe(0);
    expect(results).toHaveLength(0);
  });

  it("MERGED table (user scenario): selecting cells right of a merge maps to MODEL columns, paste lands in the selection", async () => {
    // Source table whose first body cell merges over 2 columns/2 rows
    // (exactly what a previous merged-cell paste produced). DOM placeholder
    // cells are gone; visible indices drift from model columns.
    doc.body.innerHTML = "";
    const { view, root } = makeView(doc);
    const lines = DOC_LINES.map((_t) => {
      const el = doc.createElement("div");
      el.className = "cm-line";
      return el;
    });
    const table = doc.createElement("table");
    table.innerHTML =
      '<tr><th>H1</th><th>H2</th><th>H3</th></tr>' +
      '<tr><td rowspan="2" colspan="2">a</td><td>c</td></tr>' +
      '<tr><td>e</td><td>f</td></tr>';
    lines[2].appendChild(table);
    lines.forEach((l) => root.appendChild(l));

    editor = makeEditor();
    editor.lines = [
      "| H1 | H2 | H3 |",
      "| --- | --- | --- |",
      "| a | c |",
      "| e | f |",
      "",
      "hello world",
    ];
    rebuild(view, editor);

    // Flat th/td list: H1 H2 H3 a c e f → c is index 4, f is index 6.
    const cellC = table.querySelectorAll("td, th")[4] as HTMLElement; // model col 2, row 1
    const cellF = table.querySelectorAll("td, th")[6] as HTMLElement; // model col 2, row 2
    // Drag c → f: with the old cellIndex mapping this computed columns
    // 1..1-ish and pasted OUTSIDE the user's rectangle.
    dragSelect(doc, win, cellC, cellF);
    firePaste(doc, doc.body, { html: '<table><tr><td>X1</td></tr><tr><td>Y1</td></tr></table>' });
    await new Promise((r) => setTimeout(r, 10));

    expect(results[0]).toMatchObject({ kind: "pasted" });
    const text = editor.text();
    // Pasted values must appear in the LAST column (c/f positions), not in
    // the merged anchor's columns.
    expect(text).toMatch(/X1/);
    expect(text).toMatch(/Y1/);
  });

  it("drag-select with focus inside a cell → table paste is INTERCEPTED (Obsidian native would replace the whole table silently — user bug)", async () => {
    dragSelect(doc, win, cellA, cellF);
    // After the drag the focus stays in the first cell: the paste target
    // is INSIDE the td. The old code stood down for td targets and let
    // Obsidian's native paste replace the whole table with no notice.
    firePaste(doc, cellA, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));

    expect(editor.writes).toBe(1);
    expect(results[0]).toMatchObject({ kind: "pasted" });
    const text = editor.text();
    expect(text).toContain("X1");
    expect(text).toMatch(/\|\s*c\s*\|/); // outside cell survives
  });

  it("caret in a cell, no table selection, plain-text clipboard → not intercepted (normal in-cell paste)", async () => {
    firePaste(doc, cellA, { text: "plain words" });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(0); // default paste into the cell
  });

  it("caret in a cell, no table selection, TABLE clipboard → stand down (editor-paste handler owns it: whole-table replace + notice)", async () => {
    firePaste(doc, cellA, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));
    // The interceptor only owns DRAG selections over the widget; the
    // editor-paste handler (not simulated here) turns this paste into a
    // whole-table replace with a notice. Covered in editorPasteRegression.
    expect(editor.writes).toBe(0);
    expect(results).toHaveLength(0);
  });

  it("typing clears the cache and destroys the selection → stand down (editor-paste owns the no-selection path)", async () => {
    dragSelect(doc, win, cellA, cellF);
    fireKey(doc, doc.body, "x");
    // Real typing moves the caret and collapses the DOM selection.
    win.getSelection()?.removeAllRanges();
    fireKey(doc, doc.body, "Meta", true);
    fireKey(doc, doc.body, "v", true);
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(0);
    expect(results).toHaveLength(0);
  });

  it("already-prevented paste (widget takeover elsewhere) → zero side effects", async () => {
    dragSelect(doc, win, cellA, cellF);
    firePaste(doc, doc.body, { html: EXCEL_HTML, prevented: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(0);
    expect(results).toHaveLength(0);
  });

  it("non-table clipboard → default text paste, cache not leaked to next paste", async () => {
    dragSelect(doc, win, cellA, cellF);
    firePaste(doc, doc.body, { text: "plain words" });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.lastReplaced).toBe("plain words");
    // The first paste destroyed the selection (widget rebuilds in the real
    // app); a follow-up table paste has no stale selection → the interceptor
    // stands down and the editor-paste handler owns it (not simulated here).
    win.getSelection()?.removeAllRanges();
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(1); // only the first (text) insert
  });

  it("selection spanning two tables → blocked with a notice, document untouched", async () => {
    // A second table INSIDE the same view (another line of the note).
    const root = doc.body.querySelector(".cm-editor") as HTMLElement;
    const second = doc.createElement("table");
    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.textContent = "other";
    tr.appendChild(td);
    second.appendChild(tr);
    const hostLine = doc.createElement("div");
    hostLine.className = "cm-line";
    hostLine.appendChild(second);
    root.appendChild(hostLine);

    dragSelect(doc, win, cellA, td); // first table → second table
    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(0);
    expect(results[0]).toMatchObject({ kind: "blocked", reason: "crossTable" });
  });

  it("selection dragged past the table edge (one end outside) → blocked, NOT a whole-table replace (user bug)", async () => {
    dragSelect(doc, win, cellA, cellF);
    // The user dragged past the bottom of the table into the paragraph line.
    const para = doc.body.querySelectorAll(".cm-line")[5] as HTMLElement;
    para.textContent = "hello world";
    const paraText = para.firstChild as Text;
    const sel = win.getSelection();
    sel?.extend(paraText, 5);
    doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("selectionchange"));

    firePaste(doc, doc.body, { html: EXCEL_HTML });
    await new Promise((r) => setTimeout(r, 10));
    expect(editor.writes).toBe(0); // nothing overwritten
    expect(results[0]).toMatchObject({ kind: "blocked", reason: "crossTable" });
  });
});
