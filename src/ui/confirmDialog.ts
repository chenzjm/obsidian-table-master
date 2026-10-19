// Minimal OK/Cancel confirmation dialog built on Obsidian's Modal.

import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/**
 * Open a confirmation dialog. Resolves `true` when the confirm button is
 * clicked, `false` when cancelled or dismissed (Esc / click outside).
 */
export function confirmDialog(
  app: App,
  title: string,
  body: string,
  okText: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    new (class extends Modal {
      onOpen(): void {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", { text: body });
        new Setting(this.contentEl)
          .addButton((b) =>
            b.setButtonText(okText).setCta().onClick(() => {
              settled = true;
              this.close();
              resolve(true);
            }),
          )
          .addButton((b) => b.setButtonText(t("modal.cancel")).onClick(() => this.close()));
      }

      onClose(): void {
        this.contentEl.empty();
        if (!settled) resolve(false);
      }
    })(app).open();
  });
}
