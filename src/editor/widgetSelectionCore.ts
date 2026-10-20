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
  /** Rectangle from a DOM text selection (selectionchange listener). */
  private textRect: CachedTableSelection | null = null;
  /**
   * Rectangle from the mouse-geometry tracker (mousedown → mouseup). Takes
   * priority over textRect: the browser finalizes the text selection only
   * AFTER mouseup fires, so the last selectionchange can still report the
   * collapsed text rectangle even though the geometric one is correct.
   */
  private dragRect: CachedTableSelection | null = null;

  /** Record the rectangle of a DOM text selection, if one exists. */
  recordTextSelection(found: CachedTableSelection | null): void {
    if (found) this.textRect = found;
  }

  /** Record the geometric rectangle of a mouse drag, if one was resolved. */
  recordDragSelection(found: CachedTableSelection | null): void {
    if (found) this.dragRect = found;
  }

  onMouseDown(): void {
    this.textRect = null;
    this.dragRect = null;
  }

  onKeydown(key: string, meta: boolean, ctrl: boolean, shift: boolean): void {
    if (meta || ctrl) {
      const k = key.toLowerCase();
      if ((k === "v" || k === "c") && !shift) return; // paste / copy shortcut
      if (k === "meta" || k === "control") return; // bare modifier press
      this.textRect = null;
      this.dragRect = null;
      return;
    }
    if (MODIFIER_KEYS.has(key)) return;
    this.textRect = null; // typing / arrows / Esc / Enter … end the selection
    this.dragRect = null;
  }

  /** Read and clear (single consumption). The drag rectangle wins. */
  take(): CachedTableSelection | null {
    const r = this.dragRect ?? this.textRect;
    this.textRect = null;
    this.dragRect = null;
    return r;
  }

  /** Read without clearing (diagnostics / tests). */
  peek(): CachedTableSelection | null {
    return this.dragRect ?? this.textRect;
  }
}

/**
 * Tracks a mouse drag over a rendered table so EMPTY cells can anchor a
 * selection. A DOM text selection can only start/end at text nodes, so
 * dragging across blank cells (the common case in a sparse sheet) collapses
 * the reported rectangle to the last column that happens to contain text —
 * the user visually boxed 5 columns, the DOM said 1. Mouse events, in
 * contrast, fire on real <td> elements regardless of content: record the
 * cell under mousedown, resolve the cell under mouseup via a hit test, and
 * let the paste path prefer this geometric rectangle.
 */
export class DragCellTracker {
  private start: CellInfo | null = null;
  private pending = false;

  /** mousedown: remember the cell under the pointer (may be empty). */
  onMouseDown(cell: CellInfo | null): void {
    this.start = cell;
    this.pending = cell !== null;
  }

  /** Whether a drag that started inside a table is in flight. */
  get active(): boolean {
    return this.pending;
  }

  /**
   * mouseup: resolve the rectangle from the start cell to the cell at the
   * pointer position. Returns null when no drag is pending, the start was
   * outside a table, or the end hit-test misses the same table (the plain
   * text-selection path stays authoritative then).
   */
  onMouseUp(endCell: CellInfo | null): CachedTableSelection | null {
    const start = this.start;
    this.start = null;
    this.pending = false;
    if (!start || !endCell) return null;
    if (start.table !== endCell.table) return null;
    if (start.row === endCell.row && start.col === endCell.col) return null;
    return {
      table: start.table,
      rect: {
        top: Math.min(start.row, endCell.row),
        left: Math.min(start.col, endCell.col),
        bottom: Math.max(start.row + start.rows - 1, endCell.row + endCell.rows - 1),
        right: Math.max(start.col + start.cols - 1, endCell.col + endCell.cols - 1),
      },
    };
  }

  /** Drop any pending drag (pointer left the window, Esc, …). */
  reset(): void {
    this.start = null;
    this.pending = false;
  }
}
