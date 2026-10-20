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
  // The "paste" listener lives on the *document* in the capture phase:
  // while a rendered table is drag-selected the focus (and thus the paste
  // target) can be anywhere — the editor surface, a table cell, or nothing
  // at all (body), in which case the event never reaches the editor DOM.
  // A document-level capture listener sees every paste; we then decide by
  // the DOM selection alone. Leaving `preventDefault` untouched lets the
  // default paste run for every case we don't own.
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
      private readonly doc: Document;
      private readonly listener: (event: Event) => void;

      constructor(view: EditorView) {
        this.view = view;
        this.doc = view.dom.ownerDocument;
        this.listener = (event) => this.handle(event as ClipboardEvent);
        this.doc.addEventListener("paste", this.listener, true);
      }

      destroy(): void {
        this.doc.removeEventListener("paste", this.listener, true);
      }

      private handle(event: ClipboardEvent): void {
        // Every markdown view runs its own copy of this plugin; the first
        // one that takes over sets defaultPrevented, the rest stand down.
        if (event.defaultPrevented) return;

        const found = domSelectionRect(this.view);
        if (!found) return; // no cross-cell table selection → default paste

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
        void pasteIntoWidgetTable(this.view, found.table, found.rect, parsed.model, parsed.source, handlers);
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
