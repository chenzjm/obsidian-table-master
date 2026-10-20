import { Editor, MarkdownView, Notice, Plugin } from "obsidian";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { DEFAULT_SETTINGS, TableMasterSettings, TableMasterSettingTab } from "./settings";
import { setLanguage, t } from "./i18n";
import * as actions from "./editor/actions";
import { getActionContext } from "./editor/contextHelper";
import { locateTable, getSelectionRectIn, type SelectionRect } from "./editor/tableLocator";
import { buildWidgetTablePasteExt } from "./editor/widgetPaste";
import { parseTable } from "./table/parser";
import { serialize } from "./table/serializer";
import { navigateCell, navigateRowEnter } from "./editor/cellNavigator";
import { buildFloatingToolbarExt } from "./ui/floatingToolbar";
import { registerContextMenu } from "./ui/contextMenu";
import { buildTableWidgetContextMenuExt } from "./ui/tableWidgetMenu";
import { buildTableMergePostProcessor } from "./render/postProcessor";
import { buildLivePreviewExt } from "./render/livePreview";
import { GridEditorModal } from "./ui/gridEditorModal";
import { NewTableModal } from "./ui/newTableModal";
import { emptyModel, TableModel } from "./table/model";

const CONFLICT_PLUGIN_IDS = [
  "table-editor-obsidian", // Advanced Tables
  "obsidian-markdown-table-editor",
  "table-extended",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSettings(data: unknown): Partial<TableMasterSettings> {
  if (!isRecord(data)) return {};
  const settings: Partial<TableMasterSettings> = {};
  if (data.outputFormat === "extended" || data.outputFormat === "html") settings.outputFormat = data.outputFormat;
  if (typeof data.showFloatingToolbar === "boolean") settings.showFloatingToolbar = data.showFloatingToolbar;
  if (
    data.floatingToolbarPosition === "on-click" ||
    data.floatingToolbarPosition === "follow-mouse" ||
    data.floatingToolbarPosition === "top-left"
  ) {
    settings.floatingToolbarPosition = data.floatingToolbarPosition;
  }
  if (typeof data.enableTabNavigation === "boolean") settings.enableTabNavigation = data.enableTabNavigation;
  if (data.defaultAlign === "left" || data.defaultAlign === "center" || data.defaultAlign === "right" || data.defaultAlign === "none") {
    settings.defaultAlign = data.defaultAlign;
  }
  if (data.language === "auto" || data.language === "en" || data.language === "zh") settings.language = data.language;
  return settings;
}

export default class TableMasterPlugin extends Plugin {
  settings: TableMasterSettings = DEFAULT_SETTINGS;

  onload(): void {
    // Obsidian's `Plugin.onload` signature is declared as `void` even though
    // it accepts a Promise at runtime; declaring this method `async` makes
    // typescript-eslint's `no-misused-promises` flag the override mismatch.
    // Keep the wrapper synchronous and run the actual init in a fire-and-
    // forget helper. We purposely register every editor extension and
    // command immediately (without waiting for `loadSettings`) so plugin
    // lifecycle is consistent; settings have a sane default value (see
    // `DEFAULT_SETTINGS`) until the on-disk copy finishes loading.
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    await this.loadSettings();
    setLanguage(this.settings.language);

    // Reading-view post-processor for merged cells
    this.registerMarkdownPostProcessor(
      buildTableMergePostProcessor({ component: this, app: this.app }),
    );

    // Floating toolbar (CM6 ViewPlugin)
    this.registerEditorExtension(
      buildFloatingToolbarExt({
        getApp: () => this.app,
        getPlugin: () => this,
      }),
    );

    // Live Preview merge renderer (CM6 ViewPlugin). The implementation only
    // toggles rowspan/colspan attributes and hides placeholder cells, so it
    // does not interfere with Obsidian's table widget the way a full DOM
    // rebuild would.
    this.registerEditorExtension(buildLivePreviewExt());

    // Tab / Shift-Tab / Enter navigation inside tables
    this.registerEditorExtension(
      Prec.high(
        keymap.of([
          {
            key: "Tab",
            run: () => {
              if (!this.settings.enableTabNavigation) return false;
              const view = this.app.workspace.getActiveViewOfType(MarkdownView);
              if (!view) return false;
              return navigateCell(view.editor, "next");
            },
          },
          {
            key: "Shift-Tab",
            run: () => {
              if (!this.settings.enableTabNavigation) return false;
              const view = this.app.workspace.getActiveViewOfType(MarkdownView);
              if (!view) return false;
              return navigateCell(view.editor, "prev");
            },
          },
          {
            key: "Enter",
            run: () => {
              if (!this.settings.enableTabNavigation) return false;
              const view = this.app.workspace.getActiveViewOfType(MarkdownView);
              if (!view) return false;
              const loc = locateTable(view.editor);
              if (!loc) return false;
              return navigateRowEnter(view.editor);
            },
          },
        ]),
      ),
    );

    // Right-click menu — both the standard `editor-menu` event hook and a
    // capture-phase DOM interceptor for Live Preview's table widget (which
    // would otherwise swallow the right-click for its own built-in menu).
    registerContextMenu(this);
    this.registerEditorExtension(
      buildTableWidgetContextMenuExt({ getPlugin: () => this }),
    );

    // Live Preview Cmd/Ctrl+V range paste. Obsidian's table widgets swallow
    // pastes before the `editor-paste` event fires, so intercept them at the
    // CM DOM level instead: a DOM selection spanning 2+ cells of the same
    // table plus a table clipboard becomes a range paste.
    this.registerEditorExtension(
      buildWidgetTablePasteExt({
        getActionContext: () => {
          const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
          return editor
            ? { app: this.app, editor, format: this.settings.outputFormat }
            : null;
        },
        onResult: (result) => this.notifyImportResult(result),
        onFallbackError: () => new Notice(t("notice.importFailed")),
      }),
    );

    // When the user switches between markdown leaves (split panes, hover
    // editors, secondary tabs), Obsidian doesn't necessarily emit a CM6
    // update on the leaving view, so its floating toolbar would otherwise
    // remain visible alongside the new active leaf's toolbar. Re-broadcast
    // the same event the settings tab uses; every ViewPlugin instance is
    // already listening and will re-evaluate its visibility against the new
    // active leaf.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.broadcastSettingsChanged();
      }),
    );

    // Commands
    this.registerCommands();

    // Cmd/Ctrl+V range paste: when the selection is a clean rectangle of
    // cells inside a table and the clipboard carries a table (Excel / web),
    // intercept the paste and overwrite just that region. Every other paste
    // is left to the default behaviour.
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor) => this.handleEditorPaste(evt, editor)),
    );

    // Settings tab
    this.addSettingTab(new TableMasterSettingTab(this.app, this));

    // Conflict warning
    this.warnIfConflictingPlugins();
  }

  onunload(): void {
    // Final safety sweep: Obsidian doesn't always reconfigure already-open
    // CodeMirror views when a plugin unloads, so any floating toolbars that
    // were attached to a markdown view's wrapper may otherwise leak. Remove
    // every DOM node we tagged on construction.
    // We scan every document that hosts a markdown leaf (main + popout
    // windows) — the bare `document` global only sees the main window, which
    // would leak any toolbar that lives in a popout. obsidianmd's
    // `prefer-active-doc` rule forbids that bare reference too.
    const seen = new Set<Document>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      doc
        .querySelectorAll<HTMLElement>('[data-tm-floating-toolbar="1"]')
        .forEach((el) => el.remove());
    });
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, readSettings(data));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Dispatch the `table-master:settings-changed` event into every document
   * that hosts a markdown view. We can't rely on the global `document` (the
   * obsidianmd lint rule forbids that bare reference, and it would also miss
   * popout windows entirely), so we walk the workspace's leaves and emit the
   * event on each unique `ownerDocument`. Each floating-toolbar instance
   * subscribes to its own `view.dom.ownerDocument`, so this guarantees the
   * broadcast reaches main + popout windows alike.
   */
  broadcastSettingsChanged(): void {
    const seen = new Set<Document>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view?.containerEl?.ownerDocument;
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      doc.dispatchEvent(new CustomEvent("table-master:settings-changed"));
    });
  }

  private registerCommands(): void {
    const editorCmd = (id: string, name: string, fn: (ctx: actions.ActionContext) => void) => {
      this.addCommand({
        id,
        name,
        editorCallback: (editor: Editor) => {
          const ctx = { editor, format: this.settings.outputFormat };
          fn(ctx);
        },
      });
    };

    editorCmd("insert-row-above", t("cmd.insertRowAbove"), actions.insertRowAbove);
    editorCmd("insert-row-below", t("cmd.insertRowBelow"), actions.insertRowBelow);
    editorCmd("insert-col-left", t("cmd.insertColLeft"), actions.insertColLeft);
    editorCmd("insert-col-right", t("cmd.insertColRight"), actions.insertColRight);
    editorCmd("delete-row", t("cmd.deleteRow"), actions.deleteRow);
    editorCmd("delete-col", t("cmd.deleteCol"), actions.deleteCol);
    editorCmd("move-row-up", t("cmd.moveRowUp"), actions.moveRowUp);
    editorCmd("move-row-down", t("cmd.moveRowDown"), actions.moveRowDown);
    editorCmd("move-col-left", t("cmd.moveColLeft"), actions.moveColLeft);
    editorCmd("move-col-right", t("cmd.moveColRight"), actions.moveColRight);
    editorCmd("align-left", t("cmd.alignLeft"), (c) => actions.alignColumn(c, "left"));
    editorCmd("align-center", t("cmd.alignCenter"), (c) => actions.alignColumn(c, "center"));
    editorCmd("align-right", t("cmd.alignRight"), (c) => actions.alignColumn(c, "right"));
    editorCmd("align-none", t("cmd.alignNone"), (c) => actions.alignColumn(c, "none"));
    editorCmd("merge-up", t("cmd.mergeUp"), actions.mergeUp);
    editorCmd("merge-down", t("cmd.mergeDown"), actions.mergeDown);
    editorCmd("merge-left", t("cmd.mergeLeft"), actions.mergeLeft);
    editorCmd("split-cell", t("cmd.splitCell"), actions.splitCell);
    editorCmd("format-table", t("cmd.formatTable"), actions.formatTable);
    editorCmd("sort-asc", t("cmd.sortAsc"), (c) => actions.sort(c, "asc"));
    editorCmd("sort-desc", t("cmd.sortDesc"), (c) => actions.sort(c, "desc"));

    // Open grid editor. Available everywhere — `openGridEditor` itself
    // picks between editing the current table, designing a new one and
    // inserting at the cursor, or designing one and copying to clipboard.
    this.addCommand({
      id: "open-grid-editor",
      name: t("cmd.openGridEditor"),
      callback: () => this.openGridEditor(),
    });

    // Toggle floating toolbar
    this.addCommand({
      id: "toggle-floating-toolbar",
      name: t("cmd.toggleFloating"),
      callback: async () => {
        this.settings.showFloatingToolbar = !this.settings.showFloatingToolbar;
        await this.saveSettings();
      },
    });

    // Insert new table directly (no grid editor)
    this.addCommand({
      id: "new-table",
      name: t("cmd.newTable"),
      editorCallback: (editor: Editor) => {
        new NewTableModal(this.app, (spec) => {
          actions.insertNewTable(
            { editor, format: this.settings.outputFormat },
            spec.rows,
            spec.cols,
            spec.hasHeader,
          );
        }).open();
      },
    });

    // Design new table in the grid editor and insert at cursor on confirm.
    this.addCommand({
      id: "design-new-table",
      name: t("cmd.designNewTable"),
      editorCallback: (editor: Editor) => {
        new NewTableModal(
          this.app,
          (spec) => {
            const model = emptyModel(spec.rows, spec.cols);
            if (!spec.hasHeader) model.headerRows = 0;
            new GridEditorModal(this.app, model, (newModel) => {
              actions.insertModelAtCursor(
                { editor, format: this.settings.outputFormat },
                newModel,
              );
            }).open();
          },
          t("newTable.design"),
        ).open();
      },
    });

    // Import table from clipboard (Excel / web)
    this.addCommand({
      id: "import-table-from-clipboard",
      name: t("cmd.importTable"),
      editorCallback: () => void this.importTableFromClipboard(),
    });
  }

  /**
   * Read a table from the system clipboard (HTML or TSV) and either replace
   * the current table or insert a new one at the cursor. Reports outcome via
   * an Obsidian notice.
   */
  async importTableFromClipboard(): Promise<void> {
    const ctx = getActionContext(this.app, this);
    if (!ctx) {
      new Notice(t("notice.importFailed"));
      return;
    }
    let result: actions.ClipboardImportResult;
    try {
      result = await actions.importTableFromClipboard(ctx);
    } catch {
      new Notice(t("notice.importFailed"));
      return;
    }
    this.notifyImportResult(result);
  }

  /** Shared notice mapping for clipboard import outcomes. */
  private notifyImportResult(result: actions.ClipboardImportResult): void {
    const srcLabel = (s: "html" | "tsv") => (s === "html" ? "HTML" : "TSV");
    switch (result.kind) {
      case "failed":
        new Notice(t("notice.importFailed"));
        return;
      case "noTable":
        new Notice(t("notice.importNoTable"));
        return;
      case "cancelled":
        new Notice(t("notice.importCancelled"));
        return;
      case "blocked":
        if (result.reason === "crossTable") new Notice(t("notice.selectionCrossTable"));
        else if (result.reason === "invalidLine") new Notice(t("notice.selectionInvalidLine"));
        else new Notice(t("notice.selectionPartialMerge"));
        return;
      case "pasted":
        new Notice(
          t("notice.importPasted", {
            rows: String(result.rows),
            cols: String(result.cols),
            selRows: String(result.selRows),
            selCols: String(result.selCols),
            source: srcLabel(result.source),
          }),
        );
        return;
      case "inserted":
      case "replaced":
        new Notice(t("notice.importDone", { source: srcLabel(result.source) }));
        return;
    }
  }

  /**
   * Cmd/Ctrl+V interception. Takes over the native paste when the clipboard
   * carries a table (rich HTML or TSV, e.g. copied from Excel / a web page)
   * AND the selection state is unambiguous:
   *   - rectangle of data cells inside one table → range paste;
   *   - no selection at all → the command-style import (cursor inside a
   *     table replaces it, otherwise a new table is inserted at the cursor)
   *     — Obsidian's default HTML paste would mangle the table.
   * Selections that cross tables or cover structural lines are ambiguous
   * and left to the default paste. Plain-text clipboards always default.
   */
  private handleEditorPaste(evt: ClipboardEvent, editor: Editor): void {
    // Mutual exclusion with the Live Preview widget paste interceptor: it
    // listens at the document capture phase, runs first, and marks the event
    // prevented once it takes over. Without this guard both handlers ran for
    // the same paste — the selection paste and the whole-table replace raced
    // and the whole-table write could clobber the selection result.
    if (evt.defaultPrevented) return;

    let sel: SelectionRect;
    try {
      sel = getSelectionRectIn(editor, editor.getCursor("from"), editor.getCursor("to"));
    } catch {
      return; // selection geometry unreadable → default paste
    }
    if (sel.kind === "cross" || sel.kind === "invalid") {
      // WPS behaviour: a TABLE clipboard combined with an invalid selection
      // (spanning two tables, leaving the table, or touching a separator
      // line) is blocked with a notice — the default paste would corrupt
      // the document with escaped-pipe text. A non-table clipboard still
      // goes through the default paste untouched.
      const data = evt.clipboardData;
      const html = data?.getData("text/html") ?? "";
      const text = data?.getData("text/plain") ?? "";
      if (actions.parseClipboardModel({ html: html || undefined, text: text || undefined })) {
        evt.preventDefault();
        new Notice(t("notice.selectionCrossTable"));
      }
      return;
    }

    const data = evt.clipboardData;
    if (!data) return;
    const payload: actions.ClipboardPayload = {
      html: data.getData("text/html") || undefined,
      text: data.getData("text/plain") || undefined,
    };
    if (payload.html) {
      const parsed = actions.parseClipboardModel(payload);
      if (!parsed) return; // not a table → default paste
      evt.preventDefault();
      this.runTablePaste(evt, editor, sel, parsed.model, parsed.source);
      return;
    }

    // No HTML on the event (macOS Excel/WPS): the TSV text alone loses
    // merged cells. Suppress the default, recover the rich payload from the
    // system clipboard asynchronously, and fall back to a plain text insert
    // when even that has no HTML table.
    evt.preventDefault();
    void actions
      .resolvePastePayload(data)
      .then((resolved) => {
        const parsed = actions.parseClipboardModel(resolved);
        if (parsed) {
          this.runTablePaste(evt, editor, sel, parsed.model, parsed.source);
          return;
        }
        // Not a table after all → reproduce the default text paste.
        if (resolved.text) editor.replaceSelection(resolved.text);
      })
      .catch(() => {
        if (payload.text) editor.replaceSelection(payload.text);
      });
  }

  /** Shared tail of both interception paths once a table model is resolved. */
  private runTablePaste(
    _evt: ClipboardEvent,
    editor: Editor,
    sel: SelectionRect,
    model: TableModel,
    source: "html" | "tsv",
  ): void {
    const ctx: actions.ActionContext = {
      app: this.app,
      editor,
      format: this.settings.outputFormat,
    };
    if (sel.kind === "rect") {
      void actions
        .pasteModelIntoSelection(ctx, model, source, sel)
        .then((result) => this.notifyImportResult(result))
        .catch(() => new Notice(t("notice.importFailed")));
      return;
    }
    // No selection: command-style import (replace table / insert new one).
    try {
      const result = actions.importModelNoSelection(ctx, model, source);
      this.notifyImportResult(result);
    } catch {
      new Notice(t("notice.importFailed"));
    }
  }

  /**
   * Public hook used by the floating toolbar and right-click menu.
   *
   * Three modes, in order of preference:
   *   1. Cursor inside a markdown table → open the grid editor on that
   *      table; the modified model replaces the source on confirm.
   *   2. Cursor in a markdown editor but not in a table → prompt for a new
   *      table size, design it in the grid editor, then insert the result
   *      at the cursor on confirm.
   *   3. No active markdown editor at all (e.g. file explorer focused) →
   *      same design flow but the resulting markdown is copied to the
   *      clipboard so the user can paste it anywhere.
   */
  openGridEditor(): void {
    const ctx = getActionContext(this.app, this);

    // Mode 1: edit the table the cursor is in.
    if (ctx) {
      const loc = locateTable(ctx.editor);
      if (loc) {
        let model: TableModel;
        try {
          model = parseTable(loc.text).model;
        } catch {
          new Notice(t("notice.notInTable"));
          return;
        }
        new GridEditorModal(this.app, model, (newModel) => {
          actions.replaceTable(ctx, newModel);
        }).open();
        return;
      }
    }

    // Mode 2 / 3: design a fresh table, then either insert or copy.
    new NewTableModal(this.app, (spec) => {
      const blank = emptyModel(spec.rows, spec.cols);
      if (!spec.hasHeader) blank.headerRows = 0;
      new GridEditorModal(this.app, blank, (newModel) => {
        if (ctx) {
          actions.insertModelAtCursor(ctx, newModel);
          return;
        }
        const md = serialize(newModel, this.settings.outputFormat);
        navigator.clipboard
          .writeText(md)
          .then(() => new Notice(t("notice.copiedToClipboard")))
          .catch(() => new Notice(t("notice.copyFailed")));
      }).open();
    }, t("newTable.design")).open();
  }

  private warnIfConflictingPlugins(): void {
    const enabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
    if (!enabled) return;
    const found = CONFLICT_PLUGIN_IDS.filter((id) => enabled.has(id));
    if (found.length === 0) return;
    new Notice(t("notice.conflictPlugins", { plugins: found.join(", ") }), 8000);
  }
}
