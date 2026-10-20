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
  DragCellTracker,
  rectFromCellInfos,
  logicalCellPosition,
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

/** TEMPORARY diagnostics for the Live Preview paste flow (prefix [TM-PASTE]). */
const TM_DEBUG = (...args: unknown[]): void => {
  console.debug("[TM-PASTE]", ...args);
};

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
  private readonly dragTracker = new DragCellTracker();

  private readonly listener = (event: Event): void => {
    switch (event.type) {
      case "selectionchange": {
        const live = this.currentTableSelection();
        TM_DEBUG("selectionchange →", live ? `rect r${live.rect.top}c${live.rect.left}-r${live.rect.bottom}c${live.rect.right}` : "no table selection");
        this.cache.recordTextSelection(live);
        break;
      }
      case "mousedown": {
        const target = event.target as HTMLElement | null;
        const td = target?.closest?.("td, th") as HTMLTableCellElement | null;
        const table = (td?.closest("table") as HTMLTableElement | null) ?? null;
        const cell = td && table ? logicalCellPosition(table, td) : null;
        this.cache.onMouseDown();
        this.dragTracker.onMouseDown(cell);
        TM_DEBUG("mousedown → cache cleared, drag start:", cell ? `r${cell.row}c${cell.col}` : "outside table");
        break;
      }
      case "mouseup": {
        // Resolve the drag rectangle geometrically: empty cells carry no
        // text nodes, so a DOM selection collapses to the last column with
        // text — the mouse hit test sees the real cells.
        if (!this.dragTracker.active) break;
        const e = event as MouseEvent;
        const el = this.doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const td = el?.closest?.("td, th") as HTMLTableCellElement | null;
        const table = (td?.closest("table") as HTMLTableElement | null) ?? null;
        const endCell = td && table ? logicalCellPosition(table, td) : null;
        const dragRect = this.dragTracker.onMouseUp(endCell);
        if (dragRect) {
          TM_DEBUG(`mouseup → drag rect r${dragRect.rect.top}c${dragRect.rect.left}-r${dragRect.rect.bottom}c${dragRect.rect.right} (overrides text selection)`);
          this.cache.recordDragSelection(dragRect);
        } else {
          TM_DEBUG("mouseup → drag tracker yielded no rectangle");
        }
        break;
      }
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
    for (const type of ["selectionchange", "mousedown", "mouseup", "keydown", "paste"]) {
      this.doc.addEventListener(type, this.listener, true);
    }
  }

  destroy(): void {
    for (const type of ["selectionchange", "mousedown", "mouseup", "keydown", "paste"]) {
      this.doc.removeEventListener(type, this.listener, true);
    }
  }

  private onPaste(event: ClipboardEvent): void {
    const target = event.target as HTMLElement | null;
    TM_DEBUG(
      "paste event:",
      "prevented=" + event.defaultPrevented,
      "target=" + (target ? `${target.tagName}.${String(target.className).slice(0, 30)}` : "null"),
      "inCell=" + !!target?.closest?.("td, th"),
    );
    if (event.defaultPrevented) return;

    const data = event.clipboardData;
    if (!data) {
      TM_DEBUG("paste: no clipboardData → stand down");
      return;
    }
    const payload: ClipboardPayload = {
      html: data.getData("text/html") || undefined,
      text: data.getData("text/plain") || undefined,
    };
    TM_DEBUG("paste payload:", payload.html ? `html ${payload.html.length}b` : "no html", payload.text ? `text "${payload.text.slice(0, 40).replace(/\t/g, "\\t")}"` : "no text");

    // This interceptor exists for ONE situation the plugin's editor-paste
    // handler cannot see: a drag-selection across rendered table cells,
    // whose DOM selection CodeMirror resets to its caret before the paste
    // event fires. Everything else — source-mode selections, no-selection
    // pastes (whole-table replace / new-table insert), plain in-cell text
    // editing — is the responsibility of the plugin's editor-paste handler,
    // which understands CM selections. So: with no live widget-table
    // selection and no cached drag-selection we stand down and let the
    // event flow to it.
    // Consume the cache unconditionally: whatever this paste becomes, the
    // drag-selection it remembers must not leak into the NEXT paste (that
    // leak once made a later, unrelated paste target the old rectangle).
    const cached = this.cache.take();
    const live = this.currentLiveSelection();
    if (live.status === "invalid") {
      // A selection partially inside a table (dragged past the table edge
      // or spanning two tables) is blocked with a notice, never silently
      // treated as "no selection" — that used to replace the whole table.
      TM_DEBUG("→ BLOCK (cross-table / partial selection)");
      event.preventDefault();
      this.handlers.onResult({ kind: "blocked", reason: "crossTable" });
      return;
    }
    // The GEOMETRIC drag rectangle wins over the live DOM text selection:
    // empty cells carry no text nodes, so a drag across a sparse sheet
    // collapses its text selection to the last column containing text,
    // while the mousedown/mouseup hit test saw the real cells. The text
    // selection is only the fallback for keyboard selections and drags
    // whose mouseup landed outside the table.
    const selection = cached ?? (live.status === "rect" ? { table: live.table, rect: live.rect } : null);
    TM_DEBUG(
      "selection sources:",
      "live=" + live.status,
      live.status === "rect" ? `live rect r${live.rect.top}c${live.rect.left}-r${live.rect.bottom}c${live.rect.right}` : "",
      "cached=" + (cached ? `r${cached.rect.top}c${cached.rect.left}-r${cached.rect.bottom}c${cached.rect.right}` : "n/a"),
    );
    if (!selection) {
      TM_DEBUG("→ stand down: no widget-table selection → editor-paste handler owns this paste");
      return;
    }

    if (payload.html) {
      const parsed = parseClipboardModel(payload);
      if (!parsed) {
        TM_DEBUG("→ not a table clipboard → default paste");
        return; // not a table → default paste
      }
      TM_DEBUG(`→ TAKE OVER: ${parsed.source} table ${parsed.model.rows.length}x${parsed.model.cols} → range paste`);
      // The paste target may sit inside a cell (focus stays in the first
      // dragged cell after a drag-selection) — we still take over, because
      // Obsidian's native table paste would silently replace the WHOLE
      // table with no notice.
      event.preventDefault();
      this.dispatchPaste(selection, parsed.model, parsed.source);
      return;
    }

    // No HTML on the event (macOS Excel/WPS): recover the rich payload
    // asynchronously. The selection is only consumable right now (the
    // widget rebuilds after the paste), so we take over even without HTML;
    // a text-only clipboard falls back to reproducing the default insert.
    TM_DEBUG("→ TAKE OVER (async clipboard recovery, range paste)");
    event.preventDefault();
    void resolvePastePayload(data)
      .then((resolved) => {
        const parsed = parseClipboardModel(resolved);
        if (parsed) {
          this.dispatchPaste(selection, parsed.model, parsed.source);
          return;
        }
        // Not a table after all → reproduce the default text paste.
        TM_DEBUG("async recovery: not a table → plain text insert");
        if (resolved.text) this.defaultTextInsert(resolved.text);
      })
      .catch((err) => {
        TM_DEBUG("async recovery failed:", err);
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
      const ok = table instanceof HTMLTableElement && table.isConnected;
      TM_DEBUG("dispatch: selection paste,", ok ? "table ok" : "TABLE INVALID (not connected / not a table element)");
      if (!ok) return;
      void pasteIntoWidgetTable(this.view as unknown as EditorView, table, cached.rect, model, source, this.handlers);
      return;
    }
    TM_DEBUG("dispatch: no selection → whole-table insert/replace path");
    const ctx = this.handlers.getActionContext(this.view as unknown as EditorView);
    if (!ctx) {
      TM_DEBUG("dispatch: no action context → fallback error");
      this.handlers.onFallbackError();
      return;
    }
    try {
      const result = importModelNoSelection(ctx, model, source);
      TM_DEBUG("dispatch: result =", result.kind);
      this.handlers.onResult(result);
    } catch (err) {
      TM_DEBUG("dispatch: importModelNoSelection threw:", err);
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
    | { status: "rect"; table: CachedTableSelection["table"]; rect: WidgetSelectionRect }
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
  // Map through the LOGICAL grid: with merges rendered, visible cellIndex
  // drifts from the model's column numbers (placeholder cells are gone
  // from the DOM), which pasted selections outside the user's rectangle.
  return logicalCellPosition(table, cell);
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
    TM_DEBUG("pasteIntoWidgetTable: no action context → fallback error");
    handlers.onFallbackError();
    return;
  }

  // Map the DOM table back to its source lines. While the widget holds
  // focus the CM cursor may sit anywhere, so we must not rely on it.
  let loc: TableLocation | null = null;
  try {
    const pos = view.posAtDOM(table);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length))).number - 1;
    TM_DEBUG("pasteIntoWidgetTable: table at source line", line);
    loc = locateTableIn(
      {
        getLine: (n: number) => view.state.doc.line(n + 1).text,
        lineCount: () => view.state.doc.lines,
      },
      { line, ch: 0 },
    );
  } catch (err) {
    TM_DEBUG("pasteIntoWidgetTable: posAtDOM/locateTableIn threw:", err);
    loc = null;
  }
  if (!loc) {
    TM_DEBUG("pasteIntoWidgetTable: table NOT located in source → fallback error");
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
    TM_DEBUG("pasteModelIntoSelection result =", result.kind);
    handlers.onResult(result);
  } catch (err) {
    TM_DEBUG("pasteModelIntoSelection threw:", err);
    handlers.onFallbackError();
  }
}
