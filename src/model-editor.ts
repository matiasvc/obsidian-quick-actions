import { AbstractInputSuggest, App, Modal, Notice, SecretComponent, Setting, setIcon } from "obsidian";
import { ModelConfig } from "./types";
import { DEFAULT_MAX_TOKENS, PROVIDERS, ProviderModel, listModels, testModel } from "./llm";
import { formatSeconds } from "./ui";

declare const window: Window & { moment: typeof import("moment") };

// The provider's model IDs under the Model ID field, newest first. Typing any other ID still works.
class ModelIdSuggest extends AbstractInputSuggest<ProviderModel> {
  private list: Promise<ProviderModel[]> | null = null;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private load: () => Promise<ProviderModel[]>,
    private inUse: Set<string>,
    private onPick: (id: string) => void,
    private onError: (message: string | null) => void,
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  // The provider or key changed, so the next lookup asks again. A failed lookup is kept until then,
  // so typing doesn't send one failing request per key.
  reset(): void {
    this.list = null;
  }

  async getSuggestions(query: string): Promise<ProviderModel[]> {
    this.list ??= this.load();
    let models: ProviderModel[];
    try {
      models = await this.list;
      this.onError(null);
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      return [];
    }
    const q = query.toLowerCase().trim();
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  }

  renderSuggestion(model: ProviderModel, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title quick-actions-mono", text: model.id });
    const note = [model.label !== model.id ? model.label : "", model.created ? window.moment(model.created).format("D MMM YYYY") : ""].filter((s) => s);
    if (note.length) content.createDiv({ cls: "suggestion-note", text: note.join(" · ") });
    if (this.inUse.has(model.id)) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair quick-actions-flair", text: "In use" });
  }

  selectSuggestion(model: ProviderModel): void {
    this.setValue(model.id);
    this.onPick(model.id);
    this.close();
  }
}

export class ModelEditModal extends Modal {
  private draft: ModelConfig;
  private onSave: (model: ModelConfig) => void;
  private isNew: boolean;

  // `others` are the other models, whose names this one must not take.
  constructor(app: App, model: ModelConfig, isNew: boolean, private others: ModelConfig[], onSave: (model: ModelConfig) => void) {
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
      .setDesc("How it appears in Ask a model steps. Renaming it updates the steps that use it.")
      .addText((t) => t.setValue(this.draft.name).onChange((v) => (this.draft.name = v)));

    let suggest: ModelIdSuggest | null = null;
    let limitInput: HTMLInputElement | null = null;
    // What an empty Output limit means for the provider.
    const noLimit = () => (this.draft.provider === "openai" ? "No limit" : String(DEFAULT_MAX_TOKENS));
    new Setting(contentEl).setName("Provider").addDropdown((d) => {
      for (const p of PROVIDERS) d.addOption(p.value, p.label);
      d.setValue(this.draft.provider).onChange((v) => {
        this.draft.provider = v === "openai" ? "openai" : "anthropic";
        suggest?.reset();
        if (limitInput) limitInput.placeholder = noLimit();
      });
    });

    const idSetting = new Setting(contentEl).setName("Model ID");
    const idDesc = "As the provider's API expects it. Click the field for the provider's list.";
    idSetting.setDesc(idDesc);
    idSetting.addText((t) => {
      t.inputEl.addClass("quick-actions-mono");
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- a model id, not prose
      t.setPlaceholder("claude-sonnet-4-6").setValue(this.draft.model).onChange((v) => (this.draft.model = v));
      suggest = new ModelIdSuggest(
        this.app,
        t.inputEl,
        () => listModels(this.app, this.draft),
        new Set(this.others.map((m) => m.model)),
        (id) => (this.draft.model = id),
        (message) => {
          idSetting.descEl.toggleClass("quick-actions-error", message !== null);
          idSetting.setDesc(message ?? idDesc);
        },
      );
    });

    new Setting(contentEl)
      .setName("API key")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Keychain is the settings tab name
      .setDesc("A secret from Settings › Keychain. The key itself never lives in this plugin's data.")
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(this.draft.secret_id).onChange((v) => {
          this.draft.secret_id = v;
          suggest?.reset();
        }),
      );

    new Setting(contentEl)
      .setName("Output limit")
      .setDesc("The most tokens a reply may use, thinking included. A reply that reaches it stops the step. Raise it if long drafts or high effort get cut off.")
      .addText((t) => {
        limitInput = t.inputEl;
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.setPlaceholder(noLimit())
          .setValue(this.draft.max_tokens ? String(this.draft.max_tokens) : "")
          .onChange((v) => {
            // Undefined rather than deleted, so saving over the stored model clears it too.
            const n = Number.parseInt(v, 10);
            this.draft.max_tokens = n > 0 ? n : undefined;
          });
      });

    const connection = new Setting(contentEl).setName("Connection").setDesc("");
    const status = connection.descEl;
    connection.addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        b.setDisabled(true);
        status.empty();
        status.setText("Testing…");
        try {
          const ms = await testModel(this.app, this.draft);
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
    const name = this.draft.name.trim();
    if (!name) {
      new Notice("Give the model a name");
      return;
    }
    if (this.others.some((m) => m.name === name)) {
      new Notice(`Another model is already called ${name}`);
      return;
    }
    this.onSave({ ...this.draft, name });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
