// @vitest-environment happy-dom
// Tests for the rich-payload recovery: when a paste event carries no
// text/html (macOS Excel/WPS frequently omit it), the payload is re-read
// from the system clipboard asynchronously so merged cells survive.
// Simulates the user-reported bug: copying two merged cells from Excel
// pasted as a single-column table. Needs a DOM because the recovery
// feeds the HTML into the real importer (DOMParser).

import { describe, expect, it, vi, afterEach } from "vitest";
import { resolvePastePayload, parseClipboardModel, importModelNoSelection, type ActionContext } from "./actions";

/** Excel-style rich payload with merged cells, as the system clipboard returns it. */
const EXCEL_MERGED_HTML =
  '<meta charset="utf-8"><table>' +
  '<tr><td colspan="2">测试</td></tr>' +
  '<tr><td colspan="2">测试1</td></tr>' +
  "</table>";

/** What the bare TSV flavor looks like for a purely merged region (no tabs). */
const MERGED_TSV = "测试\n测试1";

function withAsyncClipboard(html: string | null): void {
  const blobFor = (s: string) => ({ text: () => Promise.resolve(s) });
  const items = html ? [{ types: ["text/html"], getType: () => blobFor(html) }] : [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        read: vi.fn().mockResolvedValue(items),
      },
    },
  });
}

describe("resolvePastePayload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the event's HTML when present (no async read needed)", async () => {
    const read = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { read } },
    });
    const fakeEvent = {
      getData: (type: string) => (type === "text/html" ? EXCEL_MERGED_HTML : "x\ty"),
    } as unknown as DataTransfer;
    const payload = await resolvePastePayload(fakeEvent);
    expect(payload.html).toBe(EXCEL_MERGED_HTML);
    expect(read).not.toHaveBeenCalled();
  });

  it("recovers the HTML flavor from the system clipboard when the event lacks it (user bug)", async () => {
    withAsyncClipboard(EXCEL_MERGED_HTML);
    const fakeEvent = {
      getData: (type: string) => (type === "text/plain" ? MERGED_TSV : ""),
    } as unknown as DataTransfer;
    const payload = await resolvePastePayload(fakeEvent);
    expect(payload.html).toBe(EXCEL_MERGED_HTML);
  });

  it("falls back to the event text when even the async read has no HTML", async () => {
    withAsyncClipboard(null);
    const fakeEvent = {
      getData: (type: string) => (type === "text/plain" ? "a\tb\nc\td" : ""),
    } as unknown as DataTransfer;
    const payload = await resolvePastePayload(fakeEvent);
    expect(payload.html).toBeUndefined();
    expect(payload.text).toBe("a\tb\nc\td");
  });

  it("end-to-end: merged Excel cells survive when the event only carries the degraded TSV", async () => {
    withAsyncClipboard(EXCEL_MERGED_HTML);
    const fakeEvent = {
      getData: (type: string) => (type === "text/plain" ? MERGED_TSV : ""),
    } as unknown as DataTransfer;

    // Without recovery the degraded TSV is not even recognized as a table
    // (no tabs → single column of bare lines), so the old code fell through
    // to Obsidian's default HTML paste, which rendered one <td> per row →
    // the single-column table the user saw.
    const degraded = parseClipboardModel({ text: MERGED_TSV });
    expect(degraded).toBeNull();

    // …with recovery the 2-column merge model is used and inserted.
    const payload = await resolvePastePayload(fakeEvent);
    const parsed = parseClipboardModel(payload);
    expect(parsed?.source).toBe("html");
    expect(parsed?.model.cols).toBe(2);
    expect(parsed?.model.rows[0][0].colspan).toBe(2);

    const inserted: string[] = [];
    const editor = {
      getCursor: () => ({ line: 0, ch: 0 }),
      getLine: () => "",
      lineCount: () => 1,
      replaceRange: (text: string) => inserted.push(text),
      transaction: (spec: { changes?: { text: string }[] }) =>
        inserted.push(...(spec.changes ?? []).map((c) => c.text)),
    };
    const ctx = { app: {}, editor, format: "gfm" } as unknown as ActionContext;
    const result = importModelNoSelection(ctx, parsed!.model, parsed!.source);
    expect(result.kind).toBe("inserted");
    const text = inserted.join("\n");
    expect(text).toContain("测试");
    expect(text).toContain("<"); // colspan placeholder preserved in the markdown
  });
});
