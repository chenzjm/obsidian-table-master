// Guard test: the plugin must NOT restyle table headers outside its own
// rendered DOM. A previous build shipped a global
// `.markdown-* table th { font-weight: normal }` rule that leaked into every
// Markdown table in the vault (API docs, DB schemas, design docs...) and
// changed their semantics. Headers stay on Obsidian's native styling; only
// plugin-owned surfaces (table.tm-rendered / table.tm-grid) may set weights.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

describe("no global header restyle", () => {
  it("does not touch th font-weight on vault-wide markdown tables", () => {
    expect(css).not.toMatch(/\.markdown-source-view[^{]*table th/);
    expect(css).not.toMatch(/\.markdown-rendered[^{]*table th/);
    expect(css).not.toMatch(/\.markdown-preview-view[^{]*table th/);
    expect(css).not.toMatch(/\.print[^{]*table th/);
  });

  it("keeps header weights scoped to plugin-owned tables only", () => {
    const weighted = css.match(/[^{}]*\bth\b[^{]*\{[^}]*font-weight[^}]*\}/g) ?? [];
    for (const rule of weighted) {
      expect(rule).toMatch(/table\.(tm-rendered|tm-grid)/);
    }
  });
});
