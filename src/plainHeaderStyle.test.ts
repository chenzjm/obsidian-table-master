// Guard test: the plain (non-bold) header rendering is a fixed product
// decision — Markdown table syntax requires a header row and Obsidian bolds
// it, which misrepresents pasted spreadsheet data. This test pins the CSS
// rule so a future refactor cannot silently drop it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

describe("plain header style (fixed default)", () => {
  it("renders th at normal weight in the source, reading and print views", () => {
    expect(css).toMatch(/\.markdown-source-view\.mod-cm6 table th[\s\S]*?font-weight:\s*normal/);
    expect(css).toMatch(/\.markdown-rendered table th[\s\S]*?font-weight:\s*normal/);
    expect(css).toMatch(/\.markdown-preview-view table th[\s\S]*?font-weight:\s*normal/);
  });

  it("is not gated behind a class or setting", () => {
    expect(css).not.toMatch(/tm-plain-header/);
  });
});
