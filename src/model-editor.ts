import { App, Modal, SecretComponent, Setting, setIcon } from "obsidian";
import { ModelConfig } from "./types";
import { PROVIDERS, testModel } from "./llm";
import { formatSeconds } from "./ui";

export class ModelEditModal extends Modal {
  private draft: ModelConfig;
  private onSave: (model: ModelConfig) => void;
  private isNew: boolean;

  constructor(app: App, model: ModelConfig, isNew: boolean, onSave: (model: ModelConfig) => void) {
    super(app);
    this.draft = { ...model };
    this.isNew = isNew;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("quick-actions-form");
    this.setTitle(this.isNew ? "New model" : "Edit model");

    new Setting(contentEl)
      .setName("Name")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Ask a model is a step name
      .setDesc("How it appears in Ask a model steps.")
      .addText((t) => t.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));

    new Setting(contentEl).setName("Provider").addDropdown((d) => {
      for (const p of PROVIDERS) d.addOption(p.value, p.label);
      d.setValue(this.draft.provider).onChange((v) => (this.draft.provider = v === "openai" ? "openai" : "anthropic"));
    });

    new Setting(contentEl)
      .setName("Model ID")
      .setDesc("As the provider's API expects it.")
      .addText((t) => {
        t.inputEl.addClass("quick-actions-mono");
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- a model id, not prose
        t.setPlaceholder("claude-sonnet-4-6").setValue(this.draft.model).onChange((v) => (this.draft.model = v));
      });

    new Setting(contentEl)
      .setName("API key")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Keychain is the settings tab name
      .setDesc("A secret from Settings › Keychain. The key itself never lives in this plugin's data.")
      .addComponent((el) => new SecretComponent(this.app, el).setValue(this.draft.secret_id).onChange((v) => (this.draft.secret_id = v)));

    const connection = new Setting(contentEl).setName("Connection").setDesc("");
    const status = connection.descEl;
    connection.addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        b.setDisabled(true);
        status.empty();
        status.setText("Testing…");
        try {
          const { ms } = await testModel(this.app, this.draft);
          status.empty();
          const ok = status.createSpan("quick-actions-ok");
          setIcon(ok.createSpan(), "check");
          ok.appendText(`Replied in ${formatSeconds(ms)} · ${this.draft.model}`);
        } catch (e) {
          status.empty();
          status.createSpan({ cls: "quick-actions-error", text: e instanceof Error ? e.message : String(e) });
        } finally {
          b.setDisabled(false);
        }
      }),
    );

    const footer = contentEl.createDiv("quick-actions-footer");
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.save());
    this.scope.register(["Mod"], "Enter", () => {
      this.save();
      return false;
    });
  }

  private save(): void {
    this.onSave(this.draft);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
