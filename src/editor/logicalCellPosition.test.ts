// Tests for logicalCellPosition: mapping a rendered DOM cell back to the
// LOGICAL grid coordinates of its table. The Live Preview merge renderer
// removes placeholder cells and grows the anchor's span, so visible cell
// indices drift from model coordinates whenever merges exist — the cause
// of selections pasting outside the user's rectangle.

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { logicalCellPosition } from "./widgetSelectionCore";

function table(html: string): HTMLTableElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.querySelector("table")!;
}

function cells(t: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(t.querySelectorAll("td, th"));
}

describe("logicalCellPosition (DOM → model grid mapping)", () => {
  it("plain table: DOM indices equal logical coordinates", () => {
    const t = table(`<table>
      <tr><th>H1</th><th>H2</th><th>H3</th></tr>
      <tr><td>a</td><td>b</td><td>c</td></tr>
      <tr><td>d</td><td>e</td><td>f</td></tr>
    </table>`);
    // cells() is the flat th/td list: H1 H2 H3 a b c d e f.
    const [h1, , , , b, , , , f] = cells(t);
    expect(logicalCellPosition(t, h1)).toMatchObject({ row: 0, col: 0, rows: 1, cols: 1 });
    expect(logicalCellPosition(t, b)).toMatchObject({ row: 1, col: 1 });
    expect(logicalCellPosition(t, f)).toMatchObject({ row: 2, col: 2 });
  });

  it("colspan merge: cells after the merge keep their MODEL column numbers (user bug)", () => {
    // Model: | a | < | c |  → DOM row has only 2 visible cells.
    const t = table(`<table>
      <tr><th>H1</th><th>H2</th><th>H3</th></tr>
      <tr><td colspan="2">a</td><td>c</td></tr>
    </table>`);
    // Flat list: H1 H2 H3 a c.
    const [, , , a, c] = cells(t);
    expect(logicalCellPosition(t, a)).toMatchObject({ row: 1, col: 0, cols: 2 });
    // c is model column 2, NOT visible index 1 (the drift that caused
    // pastes outside the selection).
    expect(logicalCellPosition(t, c)).toMatchObject({ row: 1, col: 2 });
  });

  it("rowspan merge: cells in the covered row keep their MODEL column numbers", () => {
    // Model: rows[1] = [a, b, c], rows[2] = [^^, e, f] (a spans down only).
    // DOM: anchor a carries rowspan=2; the second body row has only e, f.
    const t = table(`<table>
      <tr><th>H1</th><th>H2</th><th>H3</th></tr>
      <tr><td rowspan="2">a</td><td>b</td><td>c</td></tr>
      <tr><td>e</td><td>f</td></tr>
    </table>`);
    // Flat list: H1 H2 H3 a b c e f.
    const [, , , a, , , e, f] = cells(t);
    expect(logicalCellPosition(t, a)).toMatchObject({ row: 1, col: 0, rows: 2, cols: 1 });
    expect(logicalCellPosition(t, e)).toMatchObject({ row: 2, col: 1 });
    expect(logicalCellPosition(t, f)).toMatchObject({ row: 2, col: 2 });
  });

  it("rectangular 2x2 merge: the lone trailing cell keeps its MODEL column", () => {
    // Model: rows[1] = [a, <, c], rows[2] = [^^, ^^, f] (a covers a 2x2 block).
    const t = table(`<table>
      <tr><th>H1</th><th>H2</th><th>H3</th></tr>
      <tr><td rowspan="2" colspan="2">a</td><td>c</td></tr>
      <tr><td>f</td></tr>
    </table>`);
    // Flat list: H1 H2 H3 a c f.
    const [, , , a, c, f] = cells(t);
    expect(logicalCellPosition(t, a)).toMatchObject({ row: 1, col: 0, rows: 2, cols: 2 });
    expect(logicalCellPosition(t, c)).toMatchObject({ row: 1, col: 2 });
    expect(logicalCellPosition(t, f)).toMatchObject({ row: 2, col: 2 });
  });

  it("clamps malformed span attributes to 1", () => {
    const t = table(`<table>
      <tr><td rowspan="x">a</td><td colspan="-3">b</td></tr>
    </table>`);
    const [a, b] = cells(t);
    expect(logicalCellPosition(t, a)).toMatchObject({ row: 0, col: 0, rows: 1, cols: 1 });
    expect(logicalCellPosition(t, b)).toMatchObject({ row: 0, col: 1 });
  });

  it("returns null for a cell not in the table", () => {
    const t = table(`<table><tr><td>a</td></tr></table>`);
    const other = document.createElement("td");
    expect(logicalCellPosition(t, other)).toBeNull();
  });
});
