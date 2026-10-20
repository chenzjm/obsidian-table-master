// @vitest-environment happy-dom
// HTML clipboard import tests (Excel / WPS payloads). Requires a DOM because
// the importer uses the platform DOMParser.

import { describe, expect, it } from "vitest";
import { importHtmlTable } from "./htmlImporter";
import { serialize } from "./serializer";
import { parseTable } from "./parser";

/** Realistic Excel-style payload for the user's bug scenario: two rows where
 *  each row is a single merged cell spanning two columns. */
const MERGED_2COLS_HTML = `<html><body>
<!--StartFragment-->
<table>
<tr><td colspan="2">测试</td></tr>
<tr><td colspan="2">测试1</td></tr>
</table>
<!--EndFragment-->
</body></html>`;

const MERGED_2ROWS_HTML = `<table>
<tr><td rowspan="2">A</td><td>B</td></tr>
<tr><td>C</td></tr>
</table>`;

const BLOCK_MERGE_HTML = `<table>
<tr><td rowspan="2" colspan="2">X</td><td>r1</td></tr>
<tr><td>r2</td></tr>
<tr><td>a</td><td>b</td><td>c</td></tr>
</table>`;

describe("importHtmlTable with merged cells", () => {
  it("keeps the physical column count for colspan merges (user bug: single-column table)", () => {
    const model = importHtmlTable(MERGED_2COLS_HTML);
    expect(model).not.toBeNull();
    expect(model!.cols).toBe(2);
    expect(model!.rows).toHaveLength(2);
    // (0,0) is the merged anchor spanning both columns.
    expect(model!.rows[0][0].isAnchor).toBe(true);
    expect(model!.rows[0][0].colspan).toBe(2);
    expect(model!.rows[0][0].raw).toBe("测试");
    // (0,1) is a colspan placeholder.
    expect(model!.rows[0][1].isAnchor).toBe(false);
    expect(model!.rows[0][1].anchorColOffset).toBe(1);
  });

  it("keeps the physical row count for rowspan merges", () => {
    const model = importHtmlTable(MERGED_2ROWS_HTML);
    expect(model).not.toBeNull();
    expect(model!.rows).toHaveLength(2);
    expect(model!.cols).toBe(2);
    expect(model!.rows[0][0].rowspan).toBe(2);
    expect(model!.rows[1][0].isAnchor).toBe(false);
    expect(model!.rows[1][0].anchorRowOffset).toBe(1);
  });

  it("handles block merges (rowspan × colspan)", () => {
    const model = importHtmlTable(BLOCK_MERGE_HTML);
    expect(model).not.toBeNull();
    expect(model!.rows).toHaveLength(3);
    expect(model!.cols).toBe(3);
    expect(model!.rows[0][0].rowspan).toBe(2);
    expect(model!.rows[0][0].colspan).toBe(2);
    // The corner (1,1) chains back to the anchor at (0,0).
    expect(model!.rows[1][1].isAnchor).toBe(false);
  });

  it("round-trips through serialize + parseTable without losing columns", () => {
    const model = importHtmlTable(MERGED_2COLS_HTML)!;
    const md = serialize(model, "extended");
    const reparsed = parseTable(md).model;
    expect(reparsed.cols).toBe(2);
    expect(reparsed.rows).toHaveLength(2);
  });

  it("returns null for payloads without a table", () => {
    expect(importHtmlTable("<html><body><p>no table</p></body></html>")).toBeNull();
  });
});
