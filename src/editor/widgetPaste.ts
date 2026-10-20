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

export function buildWidgetTablePasteExt(handlers: WidgetPasteHandlers) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly view: EditorView;
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

      private onPaste(event: ClipboardEvent): void {
        if (event.defaultPrevented) return;
        // If the paste target is a table cell the user is editing that
        // cell — leave the default behaviour alone (and keep the cache).
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("td, th")) return;

        // Every markdown view runs its own copy of this plugin; the first
        // one that takes over sets defaultPrevented, the rest stand down
        // (and drop their stale cache too).
        const cached = this.cache.take();

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
          this.dispatchPaste(cached, parsed.model, parsed.source);
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
              this.dispatchPaste(cached, parsed.model, parsed.source);
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
          void pasteIntoWidgetTable(this.view, table, cached.rect, model, source, handlers);
          return;
        }
        const ctx = handlers.getActionContext(this.view);
        if (!ctx) {
          handlers.onFallbackError();
          return;
        }
        try {
          const result = importModelNoSelection(ctx, model, source);
          handlers.onResult(result);
        } catch {
          handlers.onFallbackError();
        }
      }

      /** Reproduce the default plain-text paste at the editor caret. */
      private defaultTextInsert(text: string): void {
        const ctx = handlers.getActionContext(this.view);
        if (!ctx) {
          handlers.onFallbackError();
          return;
        }
        ctx.editor.replaceSelection(text);
      }

      /** Resolve the current DOM selection into a cached table selection. */
      private currentTableSelection(): CachedTableSelection | null {
        // Prefer the window hosting this view (popout windows), falling
        // back to the active window like the merge renderer does.
        const win = this.view.dom.ownerDocument.defaultView ?? activeWindow;
        const sel = win.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

        const start = nodeToCell(sel.anchorNode, this.view);
        const end = nodeToCell(sel.focusNode, this.view);
        const rect = rectFromCellInfos(start, end);
        if (!rect || !start) return null;
        return { table: start.table, rect };
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
