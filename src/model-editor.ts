import { AbstractInputSuggest, App, Modal, SecretComponent, Setting, moment } from "obsidian";
import { Action, ModelConfig } from "./types";
import { ProviderModel, listModels, testModel } from "./llm";
import { DEFAULT_MAX_TOKENS, PROVIDERS, providerLabel } from "./providers";
import { ModelUse, STEP_DEFS, outputsOf } from "./steps";
import { errorMessage, formatSeconds, iconEl, renderPill, textButton } from "./ui";

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
  // so typing doesn't send one failing request per keystroke.
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
      this.onError(errorMessage(e));
      return [];
    }
    const q = query.toLowerCase().trim();
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  }

  renderSuggestion(model: ProviderModel, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title quick-actions-mono", text: model.id });
    const note = [model.label !== model.id ? model.label : "", model.created ? moment(model.created).format("D MMM YYYY") : ""].filter((s) => s);
    if (note.length) content.createDiv({ cls: "suggestion-note", text: note.join(" · ") });
    if (this.inUse.has(model.id)) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair quick-actions-flair", text: "In use" });
  }

  selectSuggestion(model: ProviderModel): void {
    this.setValue(model.id);
    this.onPick(model.id);
    this.close();
  }
}

// The action editor's head (name, last test result, Test) over a step-style card of fields and a
// Used by band.
export class ModelEditModal extends Modal {
  private draft: ModelConfig;
  private nameEl: HTMLInputElement;
  private messageEl: HTMLElement; // a failed test or a name Save refuses

  // `others` are the other models, whose names this one must not take.
  constructor(
    app: App,
    model: ModelConfig,
    private others: ModelConfig[],
    private uses: ModelUse[],
    private onSave: (model: ModelConfig) => void,
  ) {
    super(app);
    this.draft = { ...model };
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("quick-actions-model-editor");

    const head = contentEl.createDiv("quick-actions-editor-head");
    iconEl(head, STEP_DEFS.llm.icon, "quick-actions-action-icon");
    this.nameEl = head.createEl("input", { type: "text", cls: "quick-actions-name", attr: { placeholder: "Model name", spellcheck: "false" } });
    this.nameEl.value = this.draft.name;
    this.nameEl.addEventListener("input", () => {
      this.draft.name = this.nameEl.value;
      this.setMessage(null);
    });
    head.createSpan("quick-actions-spacer");
    const bar = head.createSpan("quick-actions-runbar");
    const test = textButton(head, "plug-zap", "Test", () => void this.test(test, bar));
    test.setAttr("aria-label", "Asks the model for a one-word reply with this key and model ID");
    this.messageEl = contentEl.createDiv("quick-actions-error quick-actions-model-message");

    const card = contentEl.createDiv("quick-actions-card");
    this.renderFields(card.createDiv("quick-actions-card-body"));
    this.renderUses(card.createDiv("quick-actions-band is-out"));

    // Obsidian's button row, which stacks the buttons on a phone.
    const footer = contentEl.createDiv("modal-button-container");
    footer.createEl("button", { text: "Cancel", cls: "mod-cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.save());
    this.scope.register(["Mod"], "Enter", () => {
      this.save();
      return false;
    });
  }

  // Provider and key come first, since the Model ID list needs both.
  private renderFields(body: HTMLElement): void {
    let suggest: ModelIdSuggest | null = null;
    let limitInput: HTMLInputElement | null = null;
    const provider = () => providerLabel(this.draft.provider);
    const idHint = () => (this.draft.secret_id ? `Pick from ${provider()}'s list or type an ID.` : `Choose an API key to see ${provider()}'s models.`);
    // What an empty Output limit means for the provider.
    const noLimit = () => (this.draft.provider === "openai" ? "No limit" : `Default (${DEFAULT_MAX_TOKENS.toLocaleString("en-US")})`);
    const showHint = (error: string | null = null) => {
      idSetting.descEl.toggleClass("quick-actions-error", error !== null);
      idSetting.setDesc(error ?? idHint());
    };
    const connectionChanged = () => {
      suggest?.reset();
      showHint();
    };

    new Setting(body).setName("Provider").addDropdown((d) => {
      for (const p of PROVIDERS) d.addOption(p.value, p.label);
      d.setValue(this.draft.provider).onChange((v) => {
        this.draft.provider = v === "openai" ? "openai" : "anthropic";
        if (limitInput) limitInput.placeholder = noLimit();
        connectionChanged();
      });
    });

    new Setting(body).setName("API key").addComponent((el) =>
      new SecretComponent(this.app, el).setValue(this.draft.secret_id).onChange((v) => {
        this.draft.secret_id = v;
        connectionChanged();
      }),
    );

    const idSetting = new Setting(body).setName("Model ID");
    idSetting.addText((t) => {
      t.inputEl.addClass("quick-actions-mono");
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- a model id, not prose
      t.setPlaceholder("claude-sonnet-4-6").setValue(this.draft.model).onChange((v) => (this.draft.model = v));
      suggest = new ModelIdSuggest(
        this.app,
        t.inputEl,
        // Without a key there is nothing to ask with, and the hint says so.
        () => (this.draft.secret_id ? listModels(this.app, this.draft) : Promise.resolve([])),
        new Set(this.others.map((m) => m.model)),
        (id) => (this.draft.model = id),
        showHint,
      );
    });
    showHint();

    new Setting(body)
      .setName("Output limit")
      .setDesc("Most tokens a reply may use, thinking included. Reaching it fails the step.")
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
  }

  // Each step that runs on this model, after its action, with what it produces, styled like a
  // step's Out band.
  private renderUses(band: HTMLElement): void {
    band.createSpan({ cls: "quick-actions-band-lead", text: "Used by" });
    if (this.uses.length === 0) {
      band.createSpan({ cls: "quick-actions-hint", text: "No steps run on this model yet" });
      return;
    }
    const list = band.createDiv("quick-actions-used");
    let action: Action | null = null;
    for (const use of this.uses) {
      if (use.action !== action) {
        action = use.action;
        const chip = list.createSpan("quick-actions-chip");
        iconEl(chip, action.icon);
        chip.appendText(action.name || "Untitled action");
      }
      list.createSpan({ cls: "u-muted u-small", text: `step ${use.number}` });
      for (const out of outputsOf(use.step)) renderPill(list, out.name, out.type);
    }
  }

  private async test(button: HTMLButtonElement, bar: HTMLElement): Promise<void> {
    button.disabled = true;
    bar.removeClass("is-failed");
    bar.setText("Testing…");
    this.setMessage(null);
    try {
      const ms = await testModel(this.app, this.draft);
      bar.empty();
      iconEl(bar, "check");
      bar.appendText(`Replied in ${formatSeconds(ms)}`);
    } catch (e) {
      bar.empty();
      bar.addClass("is-failed");
      iconEl(bar, "x");
      bar.appendText("Test failed");
      this.setMessage(errorMessage(e));
    } finally {
      button.disabled = false;
    }
  }

  private setMessage(text: string | null): void {
    this.messageEl.setText(text ?? "");
  }

  private save(): void {
    const name = this.draft.name.trim();
    const problem = !name ? "Give the model a name" : this.others.some((m) => m.name === name) ? `Another model is already called ${name}` : null;
    if (problem) {
      this.setMessage(problem);
      this.nameEl.focus();
      return;
    }
    this.onSave({ ...this.draft, name });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
