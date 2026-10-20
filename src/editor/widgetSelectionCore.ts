// Pure, dependency-free core of the Live Preview range paste: rectangle
// computation from resolved DOM cells plus the selection-cache state
// machine. Kept in its own module (no obsidian / actions imports) so it
// stays fully unit-testable — see widgetSelectionCore.test.ts.

/** Model-space rectangle derived from a DOM selection inside a table widget. */
export interface WidgetSelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A cell resolved from the DOM. `table` is compared by identity only. */
export interface CellInfo {
  table: unknown;
  row: number;
  col: number;
  /** rowspan, clamped to >= 1. */
  rows: number;
  /** colspan, clamped to >= 1. */
  cols: number;
}

/**
 * Map a rendered DOM cell to LOGICAL grid coordinates of its table.
 *
 * The Live Preview merge renderer removes placeholder cells from the DOM
 * and grows the anchor's rowSpan/colSpan, so `cell.cellIndex` (the index
 * among that row's visible cells) does NOT match the model's column number
 * whenever merges exist to the left of the cell — selections then paste
 * shifted outside the user's rectangle. This walks the table like an HTML
 * grid layout: every span covers its placeholder positions, restoring the
 * coordinates the expanded table model uses.
 */
export function logicalCellPosition(
  table: HTMLTableElement,
  cell: HTMLTableCellElement,
): CellInfo | null {
  /** "r:c" positions covered by an earlier anchor's span (no DOM cell there). */
  const occupied = new Set<string>();
  // querySelectorAll("tr") instead of table.rows / tr.rowIndex: those live
  // collections are not reliably implemented in embedded DOM shims, and the
  // document order of <tr> elements is exactly what we need.
  const trs = Array.from(table.querySelectorAll("tr"));
  const rowCount = trs.length;
  const spanOf = (td: HTMLTableCellElement, attr: "rowspan" | "colspan"): number => {
    const raw = td.getAttribute(attr);
    const n = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };
  for (let r = 0; r < rowCount; r++) {
    const tr = trs[r];
    // Same shims caveat: prefer children over the live HTMLTableRowElement.cells.
    const tds = Array.from(tr.children).filter(
      (el): el is HTMLTableCellElement => el.tagName === "TD" || el.tagName === "TH",
    );
    let c = 0;
    for (let i = 0; i < tds.length; i++) {
      while (occupied.has(`${r}:${c}`)) c++;
      const td = tds[i];
      const rs = spanOf(td, "rowspan");
      const cs = spanOf(td, "colspan");
      if (td === cell) {
        return { table, row: r, col: c, rows: rs, cols: cs };
      }
      for (let dr = 0; dr < rs; dr++) {
        for (let dc = 0; dc < cs; dc++) {
          if (dr || dc) occupied.add(`${r + dr}:${c + dc}`);
        }
      }
      c += cs;
    }
  }
  return null;
}

/**
 * Compute the rectangle covered by selecting from cell `a` to cell `b`.
 * Returns null when either end is missing, the ends live in different
 * tables, or both ends are the same cell (a plain in-cell text selection).
 * Anchor cells are expanded by their rowspan/colspan so a selection that
 * starts or ends inside a merged cell covers the whole merged region.
 */
export function rectFromCellInfos(a: CellInfo | null, b: CellInfo | null): WidgetSelectionRect | null {
  if (!a || !b) return null;
  if (a.table !== b.table) return null;
  if (a.row === b.row && a.col === b.col) return null;
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row + a.rows - 1, b.row + b.rows - 1),
    right: Math.max(a.col + a.cols - 1, b.col + b.cols - 1),
  };
}

export interface CachedTableSelection {
  /** Identity of the rendered table the selection belongs to. */
  table: unknown;
  rect: WidgetSelectionRect;
}

const MODIFIER_KEYS = new Set(["Shift", "Alt", "Meta", "Control", "Dead", "Process"]);

/**
 * Lifecycle of a drag-selection over a rendered Live Preview table.
 *
 * The selection is recorded whenever `recordSelection` sees a cross-cell
 * table selection (called from selectionchange). It is invalidated by any
 * mousedown (a fresh drag immediately re-records) and by any keydown that
 * is not one of the preserved shortcuts:
 *   - Cmd/Ctrl+V and Cmd/Ctrl+C keep the cache (the user is about to paste,
 *     or just copied the selection);
 *   - bare modifier presses keep it (they precede the shortcuts);
 *   - Cmd/Ctrl+Shift+V (paste without formatting) clears it — the user
 *     explicitly asked for plain text;
 *   - every other key (typing, arrows, Esc, Enter, …) clears it.
 * `take()` hands the selection to a paste and clears it (single use).
 */
export class WidgetSelectionCache {
  private cache: CachedTableSelection | null = null;

  recordSelection(found: CachedTableSelection | null): void {
    if (found) this.cache = found;
  }

  onMouseDown(): void {
    this.cache = null;
  }

  onKeydown(key: string, meta: boolean, ctrl: boolean, shift: boolean): void {
    if (meta || ctrl) {
      const k = key.toLowerCase();
      if ((k === "v" || k === "c") && !shift) return; // paste / copy shortcut
      if (k === "meta" || k === "control") return; // bare modifier press
      this.cache = null;
      return;
    }
    if (MODIFIER_KEYS.has(key)) return;
    this.cache = null; // typing / arrows / Esc / Enter … end the selection
  }

  /** Read and clear (single consumption). */
  take(): CachedTableSelection | null {
    const c = this.cache;
    this.cache = null;
    return c;
  }

  /** Read without clearing (diagnostics / tests). */
  peek(): CachedTableSelection | null {
    return this.cache;
  }
}
