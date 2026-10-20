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
