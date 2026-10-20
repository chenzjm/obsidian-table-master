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
export class Plugin {
  loadData(): Promise<null> {
    return Promise.resolve(null);
  }
  saveData(_data: unknown): Promise<void> {
    return Promise.resolve();
  }
}

export const Platform = { isMobile: false, isDesktop: true };
