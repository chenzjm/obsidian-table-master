// Tests for the synchronous clipboard gate used by the paste interceptors:
// only a rectangular TSV grid (the Excel/WPS plain-text signature) may
// trigger preventDefault() before the rich payload is recovered.

import { describe, expect, it } from "vitest";
import { looksLikeTsvTable } from "./tsvImporter";

describe("looksLikeTsvTable", () => {
  it("accepts a rectangular 2x2 TSV grid (Excel range signature)", () => {
    expect(looksLikeTsvTable("a\tb\nc\td")).toBe(true);
  });

  it("accepts wider grids (5 columns × 2 rows)", () => {
    expect(looksLikeTsvTable("a\tb\tc\td\te\nf\tg\th\ti\tj")).toBe(true);
  });

  it("accepts a 3x3 grid with CRLF line endings", () => {
    expect(looksLikeTsvTable("1\t2\t3\r\n4\t5\t6\r\n7\t8\t9")).toBe(true);
  });

  it("keeps quoted multi-line cells row-consistent", () => {
    // Second cell spans two physical lines but the logical grid is 2x2.
    expect(looksLikeTsvTable('a\t"line1\nline2"\nc\td')).toBe(true);
  });

  it("strips a trailing blank line before judging", () => {
    expect(looksLikeTsvTable("a\tb\nc\td\n\n")).toBe(true);
  });

  it("rejects a single line, even with tabs", () => {
    expect(looksLikeTsvTable("a\tb\tc")).toBe(false);
  });

  it("rejects single-column text (no tabs anywhere)", () => {
    expect(looksLikeTsvTable("line one\nline two\nline three")).toBe(false);
  });

  it("rejects ragged rows (code with tab indentation)", () => {
    // Tab-indented code has inconsistent column counts per row.
    expect(looksLikeTsvTable("if (x) {\n\treturn y;\n}")).toBe(false);
  });

  it("rejects rows whose column counts differ", () => {
    expect(looksLikeTsvTable("a\tb\nc\td\te")).toBe(false);
  });

  it("rejects empty and whitespace-only payloads", () => {
    expect(looksLikeTsvTable("")).toBe(false);
    expect(looksLikeTsvTable("   \n  ")).toBe(false);
  });
});
