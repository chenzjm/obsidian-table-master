// Minimal runtime stub of the "obsidian" package for vitest. The plugin
// code imports { App, Editor, Notice, Modal, ... } from "obsidian"; in unit
// tests we only need inert classes so the import resolves. Wired up via
// the alias in vitest.config.ts.

export class Notice {
  constructor(_message?: unknown, _timeout?: number) {}
}

export class Modal {
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class App {}
export class Editor {}
export class MarkdownView {}
export class PluginSettingTab {
  constructor(_app?: unknown, _plugin?: unknown) {}
  display(): void {}
  containerEl: unknown = null;
}
export class Setting {
  constructor(_containerEl?: unknown) {}
  setName(_name: unknown): this {
    return this;
  }
  setDesc(_desc: unknown): this {
    return this;
  }
  addDropdown(_cb: (dd: unknown) => unknown): this {
    return this;
  }
  addToggle(_cb: (tg: unknown) => unknown): this {
    return this;
  }
}
export class Plugin {
  loadData(): Promise<null> {
    return Promise.resolve(null);
  }
  saveData(_data: unknown): Promise<void> {
    return Promise.resolve();
  }
}

export const Platform = { isMobile: false, isDesktop: true };
/** Test double for the Obsidian `activeWindow` global (timers etc.). */
export const activeWindow: {
  setTimeout: (fn: () => void, ms?: number) => number;
} = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};
