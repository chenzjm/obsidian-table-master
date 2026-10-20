// Live Preview Cmd/Ctrl+V range paste.
//
// Obsidian renders Live Preview tables as CM6 widgets whose cells are plain
// DOM (editable only after clicking into them). Pastes in that state never
// reach the `editor-paste` workspace event, and — crucially — the moment
// Cmd/Ctrl+V is pressed, CodeMirror resets the drag-selection back to its
// own caret, so by the time the paste event fires the cross-cell DOM
// selection is already collapsed.
//
// The unit-tested logic lives in widgetSelectionCore.ts; this module only
// wires DOM events into it and delegates the actual paste to the shared
// selection-paste flow in actions.ts.

import { EditorView, ViewPlugin, PluginValue } from "@codemirror/view";
import type { TableModel } from "../table/model";
import { locateTableIn, type TableLocation } from "./tableLocator";
import {
  parseClipboardModel,
  pasteModelIntoSelection,
  importModelNoSelection,
  resolvePastePayload,
  type ClipboardPayload,
  type ClipboardImportResult,
  type ActionContext,
} from "./actions";
import {
  WidgetSelectionCache,
  rectFromCellInfos,
  type CellInfo,
  type CachedTableSelection,
  type WidgetSelectionRect,
} from "./widgetSelectionCore";

export {
  rectFromCellInfos,
  WidgetSelectionCache,
  type CellInfo,
  type CachedTableSelection,
  type WidgetSelectionRect,
} from "./widgetSelectionCore";

export interface WidgetPasteHandlers {
  /** Resolve the Obsidian editor + output format for the view being pasted into. */
  getActionContext: (view: EditorView) => ActionContext | null;
  /** Report the outcome (notices) — shared with the command path. */
  onResult: (result: ClipboardImportResult) => void;
  /** Called when the paste fails before a result exists (e.g. table not located). */
  onFallbackError: () => void;
}

export interface WidgetPasteView {
  /** The CM EditorView DOM root (listeners and table lookup scope). */
  dom: HTMLElement;
  /** CM helper: source position for a DOM node inside the editor. */
  posAtDOM(node: Node): number;
  /** CM document access for line-based table location. */
  state: {
    doc: {
      lineAt(pos: number): { number: number };
      line(n: number): { text: string };
      length: number;
      lines: number;
    };
  };
}

/**
 * Document-level controller that turns Live Preview DOM events into
 * selection-aware table pastes. Extracted from the ViewPlugin so the whole
 * drag-select → clipboard → paste flow is testable against a real DOM.
 */
export class WidgetPasteController {
  private readonly view: WidgetPasteView;
  private readonly doc: Document;
  private readonly cache = new WidgetSelectionCache();

  private readonly listener = (event: Event): void => {
    switch (event.type) {
      case "selectionchange":
        this.cache.recordSelection(this.currentTableSelection());
        break;
      case "mousedown":
        this.cache.onMouseDown();
        break;
      case "keydown":
        this.cache.onKeydown(
          (event as KeyboardEvent).key,
          (event as KeyboardEvent).metaKey,
          (event as KeyboardEvent).ctrlKey,
          (event as KeyboardEvent).shiftKey,
        );
        break;
      case "paste":
        this.onPaste(event as ClipboardEvent);
        break;
    }
  };

  constructor(view: WidgetPasteView, private readonly handlers: WidgetPasteHandlers) {
    this.view = view;
    this.doc = view.dom.ownerDocument;
    for (const type of ["selectionchange", "mousedown", "keydown", "paste"]) {
      this.doc.addEventListener(type, this.listener, true);
    }
  }

  destroy(): void {
    for (const type of ["selectionchange", "mousedown", "keydown", "paste"]) {
      this.doc.removeEventListener(type, this.listener, true);
    }
  }

  private onPaste(event: ClipboardEvent): void {
    if (event.defaultPrevented) return;
    // If the paste target is a table cell the user is editing that
    // cell — leave the default behaviour alone (and keep the cache).
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("td, th")) return;

    // Resolve the paste target selection from up to two sources:
    //  1. a LIVE cross-cell DOM selection at paste time (covers the case
    //     where a stray mousedown cleared the cache but the visible
    //     drag-selection is still intact), and
    //  2. the drag-selection cache (covers CodeMirror resetting the
    //     selection to its caret right before the paste event).
    // A selection that is PARTIALLY inside a table (dragged past the table
    // edge, or spanning two tables) is invalid: it must be blocked with a
    // notice, never silently treated as "no selection" — that used to
    // replace the whole table.
    const cached = this.cache.take();
    const live = this.currentLiveSelection();
    if (live.status === "invalid") {
      event.preventDefault();
      this.handlers.onResult({ kind: "blocked", reason: "crossTable" });
      return;
    }
    const selection = live.status === "rect" ? { table: live.table, rect: live.rect } : cached;

    const data = event.clipboardData;
    if (!data) return;
    const payload: ClipboardPayload = {
      html: data.getData("text/html") || undefined,
      text: data.getData("text/plain") || undefined,
    };
    if (payload.html) {
      const parsed = parseClipboardModel(payload);
      if (!parsed) return; // not a table → default paste
      event.preventDefault();
      this.dispatchPaste(selection, parsed.model, parsed.source);
      return;
    }

    // No HTML on the event (macOS Excel/WPS): the TSV text alone loses
    // merged cells. Suppress the default, recover the rich payload from
    // the system clipboard asynchronously, and fall back to a plain
    // text insert when even that has no HTML table.
    event.preventDefault();
    void resolvePastePayload(data)
      .then((resolved) => {
        const parsed = parseClipboardModel(resolved);
        if (parsed) {
          this.dispatchPaste(selection, parsed.model, parsed.source);
          return;
        }
        // Not a table after all → reproduce the default text paste.
        if (resolved.text) this.defaultTextInsert(resolved.text);
      })
      .catch(() => {
        if (payload.text) this.defaultTextInsert(payload.text);
      });
  }

  /** Run the resolved table paste for a cached or absent selection. */
  private dispatchPaste(
    cached: CachedTableSelection | null,
    model: TableModel,
    source: "html" | "tsv",
  ): void {
    if (cached) {
      const table = cached.table as HTMLTableElement | null;
      if (!(table instanceof HTMLTableElement) || !table.isConnected) return;
      void pasteIntoWidgetTable(this.view as unknown as EditorView, table, cached.rect, model, source, this.handlers);
      return;
    }
    const ctx = this.handlers.getActionContext(this.view as unknown as EditorView);
    if (!ctx) {
      this.handlers.onFallbackError();
      return;
    }
    try {
      const result = importModelNoSelection(ctx, model, source);
      this.handlers.onResult(result);
    } catch {
      this.handlers.onFallbackError();
    }
  }

  /** Reproduce the default plain-text paste at the editor caret. */
  private defaultTextInsert(text: string): void {
    const ctx = this.handlers.getActionContext(this.view as unknown as EditorView);
    if (!ctx) {
      this.handlers.onFallbackError();
      return;
    }
    ctx.editor.replaceSelection(text);
  }

  /** Resolve the current DOM selection into a cached table selection. */
  private currentTableSelection(): CachedTableSelection | null {
    const live = this.currentLiveSelection();
    return live.status === "rect" ? { table: live.table, rect: live.rect } : null;
  }

  /**
   * Three-state reading of the live DOM selection:
   *  - "rect": a cross-cell selection inside one table of this view;
   *  - "none": no selection, or entirely outside any table (default paste);
   *  - "invalid": one end inside a table and the other outside it, or the
   *    ends in two different tables — must be blocked, not ignored.
   */
  private currentLiveSelection():
    | { status: "rect"; table: HTMLElement; rect: WidgetSelectionRect }
    | { status: "none" }
    | { status: "invalid" } {
    // Prefer the window hosting this view (popout windows), falling
    // back to the active window like the merge renderer does.
    const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return { status: "none" };

    const start = nodeToCell(sel.anchorNode, this.view as unknown as EditorView);
    const end = nodeToCell(sel.focusNode, this.view as unknown as EditorView);
    if (!start && !end) return { status: "none" }; // selection has no table part
    const rect = rectFromCellInfos(start, end);
    if (rect && start) return { status: "rect", table: start.table, rect };
    return { status: "invalid" };
  }
}

export function buildWidgetTablePasteExt(handlers: WidgetPasteHandlers) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      constructor(view: EditorView) {
        // The controller owns all behaviour; the plugin only manages its
        // lifetime (created/destroyed with the CM view).
        (this as { controller?: WidgetPasteController }).controller = new WidgetPasteController(view, handlers);
      }
      destroy(): void {
        (this as { controller?: WidgetPasteController }).controller?.destroy();
      }
    },
  );
}

function nodeToCell(node: Node | null, view: EditorView): CellInfo | null {
  if (!node) return null;
  const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as HTMLElement | null;
  const cell = el?.closest?.("td, th") as HTMLTableCellElement | null;
  if (!cell) return null;
  const table = cell.closest("table") as HTMLTableElement | null;
  if (!table || !view.dom.contains(table)) return null; // another view's table
  const tr = cell.closest("tr") as HTMLTableRowElement | null;
  if (!tr) return null;
  return {
    table,
    row: tr.rowIndex,
    col: cell.cellIndex,
    rows: Math.max(1, cell.rowSpan || 1),
    cols: Math.max(1, cell.colSpan || 1),
  };
}

async function pasteIntoWidgetTable(
  view: WidgetPasteView,
  table: HTMLTableElement,
  rect: WidgetSelectionRect,
  clip: TableModel,
  source: "html" | "tsv",
  handlers: WidgetPasteHandlers,
): Promise<void> {
  const ctx = handlers.getActionContext(view as unknown as EditorView);
  if (!ctx) {
    handlers.onFallbackError();
    return;
  }

  // Map the DOM table back to its source lines. While the widget holds
  // focus the CM cursor may sit anywhere, so we must not rely on it.
  let loc: TableLocation | null = null;
  try {
    const pos = view.posAtDOM(table);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length))).number - 1;
    loc = locateTableIn(
      {
        getLine: (n: number) => view.state.doc.line(n + 1).text,
        lineCount: () => view.state.doc.lines,
      },
      { line, ch: 0 },
    );
  } catch {
    loc = null;
  }
  if (!loc) {
    handlers.onFallbackError();
    return;
  }

  // Delegate to the shared selection-paste flow (confirmation dialog,
  // model merge, single-transaction write-back, notice mapping).
  try {
    const result = await pasteModelIntoSelection(
      ctx,
      clip,
      source,
      {
        kind: "rect",
        startLine: loc.startLine,
        endLine: loc.endLine,
        ...rect,
      },
      loc,
    );
    handlers.onResult(result);
  } catch {
    handlers.onFallbackError();
  }
}
