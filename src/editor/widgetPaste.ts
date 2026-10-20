// Live Preview Cmd/Ctrl+V range paste.
//
// Obsidian renders Live Preview tables as CM6 widgets whose cells are
// contenteditable DOM. Pastes inside those widgets never reach the
// `editor-paste` workspace event (which only fires while the plain-text CM
// editor holds focus), so the source-mode interception misses them. This
// extension hooks CM's `domEventHandlers` instead: when the paste target is
// a table cell and the *DOM* selection spans at least two cells of the same
// table, we translate the selection into a model rectangle and run the same
// selection-aware paste flow used everywhere else.
//
// Everything else — single-cell selections, plain-text clipboards, pastes
// outside tables — is left to the default widget behaviour.

import { EditorView, ViewPlugin, PluginValue } from "@codemirror/view";
import type { TableModel } from "../table/model";
import { locateTableIn, type TableLocation } from "./tableLocator";
import {
  parseClipboardModel,
  pasteModelIntoSelection,
  type ClipboardPayload,
  type ClipboardImportResult,
  type ActionContext,
} from "./actions";

/** Model-space rectangle derived from a DOM selection inside a table widget. */
export interface WidgetSelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface WidgetPasteHandlers {
  /** Resolve the Obsidian editor + output format for the view being pasted into. */
  getActionContext: (view: EditorView) => ActionContext | null;
  /** Report the outcome (notices) — shared with the command path. */
  onResult: (result: ClipboardImportResult) => void;
  /** Called when the paste fails before a result exists (e.g. table not located). */
  onFallbackError: () => void;
}

export function buildWidgetTablePasteExt(handlers: WidgetPasteHandlers) {
  // The challenge this plugin solves: while a rendered (non-editable) table
  // is drag-selected, the focus stays on the editor surface. The moment the
  // user presses Cmd/Ctrl+V, CodeMirror resets the DOM selection back to its
  // own caret — so by the time the paste event fires the cross-cell
  // selection is already collapsed and reading it live is useless.
  //
  // Strategy: cache the table selection while it exists.
  //   - `selectionchange` records any cross-cell selection inside one of
  //     this view's rendered tables.
  //   - Any mousedown, and any keydown other than the paste/copy shortcuts
  //     (or bare modifier keys), invalidates the cache — a fresh drag
  //     rebuilds it immediately via selectionchange.
  //   - On paste, the cache plus a table clipboard takes over the event.
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
      private readonly doc: Document;
      private cache: { table: HTMLTableElement; rect: WidgetSelectionRect } | null = null;

      private readonly onSelectionChange = (): void => {
        const found = domSelectionRect(this.view);
        if (found) this.cache = found;
      };

      private readonly onMouseDown = (): void => {
        // A click anywhere invalidates the cached selection. Drag-selecting
        // rebuilds it through selectionchange, so this is always safe.
        this.cache = null;
      };

      private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.metaKey || event.ctrlKey) {
          // Keep the cache for the paste/copy shortcuts themselves.
          const k = event.key.toLowerCase();
          if (k === "v" || k === "c") return;
          if (k === "meta" || k === "control") return; // bare modifier press
          this.cache = null;
          return;
        }
        if (["Shift", "Alt", "Meta", "Control"].includes(event.key)) return;
        this.cache = null; // typing / arrows / Esc … end the selection
      };

      private readonly onPaste = (event: ClipboardEvent): void => {
        // Every markdown view runs its own copy of this plugin; the first
        // one that takes over sets defaultPrevented, the rest stand down.
        if (event.defaultPrevented) return;

        const cached = this.cache;
        this.cache = null; // consumed either way
        if (!cached || !cached.table.isConnected) return;

        const data = event.clipboardData;
        if (!data) return;
        const payload: ClipboardPayload = {
          html: data.getData("text/html") || undefined,
          text: data.getData("text/plain") || undefined,
        };
        const parsed = parseClipboardModel(payload);
        if (!parsed) return; // not a table → default paste

        // Both conditions met: take over the paste.
        event.preventDefault();
        void pasteIntoWidgetTable(this.view, cached.table, cached.rect, parsed.model, parsed.source, handlers);
      };

      private readonly listener = (event: Event): void => {
        if (event.type === "paste") this.onPaste(event as ClipboardEvent);
        else if (event.type === "keydown") this.onKeyDown(event as KeyboardEvent);
        else if (event.type === "mousedown") this.onMouseDown();
        else this.onSelectionChange();
      };

      constructor(view: EditorView) {
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
    },
  );
}

/**
 * Inspect the current DOM selection. When it spans at least two cells of the
 * same rendered table widget, return that table plus the model-space
 * rectangle covered (rowspan/colspan aware). Returns null otherwise.
 *
 * Cell indexes map 1:1 to model coordinates because Obsidian renders one
 * `<td>` per source cell (merge placeholders included) and Table Master
 * only toggles attributes on them.
 */
export function domSelectionRect(view: EditorView): { table: HTMLTableElement; rect: WidgetSelectionRect } | null {
  // Prefer the window hosting this view (popout windows), falling back to
  // the active window like the merge renderer does.
  const win = view.dom.ownerDocument.defaultView ?? activeWindow;
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  const start = nodeToCell(sel.anchorNode);
  const end = nodeToCell(sel.focusNode);
  if (!start || !end) return null;
  if (start.table !== end.table) return null; // crosses tables / leaves it
  if (!view.dom.contains(start.table)) return null; // another view's table
  if (start.cell === end.cell) return null; // plain in-cell text selection

  // Expand anchor cells with rowspan/colspan so a selection that starts or
  // ends inside a merged cell covers the whole merged region.
  const span = (cell: HTMLTableCellElement) => ({
    rows: Math.max(1, cell.rowSpan || 1),
    cols: Math.max(1, cell.colSpan || 1),
  });
  const s = span(start.cell);
  const e = span(end.cell);
  return {
    table: start.table,
    rect: {
      top: Math.min(start.row, end.row),
      left: Math.min(start.col, end.col),
      bottom: Math.max(start.row + s.rows - 1, end.row + e.rows - 1),
      right: Math.max(start.col + s.cols - 1, end.col + e.cols - 1),
    },
  };
}

function nodeToCell(
  node: Node | null,
): { table: HTMLTableElement; cell: HTMLTableCellElement; row: number; col: number } | null {
  if (!node) return null;
  const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as HTMLElement | null;
  const cell = el?.closest?.("td, th") as HTMLTableCellElement | null;
  if (!cell) return null;
  const table = cell.closest("table") as HTMLTableElement | null;
  if (!table) return null;
  const tr = cell.closest("tr") as HTMLTableRowElement | null;
  if (!tr) return null;
  return { table, cell, row: tr.rowIndex, col: cell.cellIndex };
}

async function pasteIntoWidgetTable(
  view: EditorView,
  table: HTMLTableElement,
  rect: WidgetSelectionRect,
  clip: TableModel,
  source: "html" | "tsv",
  handlers: WidgetPasteHandlers,
): Promise<void> {
  const ctx = handlers.getActionContext(view);
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
