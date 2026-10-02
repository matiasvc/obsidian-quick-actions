import { App, Modal, Notice, Platform, Setting, setIcon } from "obsidian";
import { Action, LLMOutput, Step, StepType } from "./types";
import QuickActionsPlugin from "./main";
import {
  FieldDef,
  ResolveMode,
  STEP_DEFS,
  STEP_TYPES_IN_ORDER,
  StepOutput,
  convertStep,
  freshOutputs,
  isModelMissing,
  makeStep,
  modelOf,
  outputHintOf,
  outputsOf,
  stepLabel,
  stepTitle,
  withoutUnavailable,
} from "./steps";
import { BUILTINS, availableInputs, consumersOf, producedNames, renameOutput, resolveSegments, resolveStep, uniqueName, usedInputs } from "./variables";
import { InsertPreview } from "./insert";
import { RunResult, StepResult, resolveOptions, runAction } from "./executor";
import { RunProgress } from "./progress";
import { FolderSuggest } from "./suggest";
import { createPillField } from "./pillfield";
import { VarItem, attachVarPicker } from "./varpicker";
import { FieldFocusTracker, copyUri, describeInput, formatSeconds, iconButton, iconEl, renderInBand, renderPill, textButton, truncate } from "./ui";
import { showAddStepMenu, showMenu, showRowMenu } from "./menus";
import { findQuickTasks } from "./quicktasks";
import { enableDragReorder, moveItem } from "./dragreorder";
import { IconPickerModal } from "./modals";

// A notice for values that later steps read and no step produces any more.
function lostSource(names: string[]): string {
  return `Later steps still use ${names.map((n) => `{{${n}}}`).join(", ")} and now need a new source.`;
}

export class ActionEditModal extends Modal {
  private plugin: QuickActionsPlugin;
  private draft: Action;
  private initialJson: string;
  private onSave: (action: Action) => void;
  private selected = 0;
  // Phones show one column: the step list, or the selected step with a back button.
  private paneOpen = false;
  private run: RunResult | null = null;
  // Bumped whenever the steps change, so a test run still going knows its results are stale.
  private runGen = 0;
  private view: "edit" | "run" = "edit";
  private running = false;
  private closed = false;
  private confirming = false; // the footer asks whether to discard changes
  private tracker = new FieldFocusTracker();
  private headEl: HTMLElement;
  private railEl: HTMLElement;
  private paneEl: HTMLElement;
  private footerEl: HTMLElement;
  private disposeDrag: (() => void) | null = null;

  constructor(app: App, plugin: QuickActionsPlugin, source: Action, onSave: (action: Action) => void) {
    super(app);
    this.plugin = plugin;
    this.initialJson = JSON.stringify(source);
    this.draft = JSON.parse(this.initialJson);
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    // mod-lg is Obsidian's full-sheet modal on phones and has no desktop rules.
    this.modalEl.addClass("quick-actions-editor", "mod-lg");
    this.headEl = contentEl.createDiv("quick-actions-editor-head");
    const split = contentEl.createDiv("quick-actions-split");
    this.railEl = split.createDiv("quick-actions-rail");
    this.paneEl = split.createDiv("quick-actions-pane");
    this.footerEl = contentEl.createDiv("quick-actions-footer");
    this.scope.register(["Mod"], "Enter", () => {
      this.save();
      return false;
    });
    this.renderHead();
    this.renderRail();
    this.renderPane();
    this.renderFooter();
  }

  // Esc, the close button and Cancel call close(). A swipe down on a phone and a click outside ask
  // canDismiss() first. With unsaved changes either one puts the discard question in the footer
  // instead, and the next one closes.
  close(): void {
    if (!this.askToDiscard()) super.close();
  }

  canDismiss(): boolean {
    return !this.askToDiscard();
  }

  // True when it has just asked, so the caller must not close.
  private askToDiscard(): boolean {
    if (this.confirming || JSON.stringify(this.draft) === this.initialJson) return false;
    this.confirming = true;
    this.renderFooter();
    return true;
  }

  onClose(): void {
    this.closed = true;
    this.disposeDrag?.();
    this.contentEl.empty();
  }

  private save(): void {
    this.onSave(this.draft);
    super.close();
  }

  private renderFooter(): void {
    const footer = this.footerEl;
    footer.empty();
    footer.toggleClass("is-confirming", this.confirming);
    if (this.confirming) {
      footer.createSpan({ cls: "quick-actions-footer-text", text: `Discard changes to ${this.draft.name || "this action"}?` });
      footer.createEl("button", { text: "Keep editing" }).addEventListener("click", () => {
        this.confirming = false;
        this.renderFooter();
      });
      const discard = footer.createEl("button", { text: "Discard", cls: "mod-warning" });
      discard.addEventListener("click", () => super.close());
      discard.focus();
      return;
    }
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.save());
  }

  private get steps(): Step[] {
    return this.draft.steps;
  }

  private get models() {
    return this.plugin.settings.models;
  }

  private resultFor(index: number): StepResult | undefined {
    return this.run?.steps.find((r) => r.index === index);
  }

  private lastRunIndex(): number {
    return this.run ? Math.max(-1, ...this.run.steps.map((r) => r.index)) : -1;
  }

  // ---- Header ----

  private renderHead(): void {
    const head = this.headEl;
    head.empty();
    const iconBtn = head.createDiv({ cls: "clickable-icon quick-actions-action-icon", attr: { "aria-label": "Icon and ribbon button" } });
    setIcon(iconBtn, this.draft.icon);
    iconBtn.addEventListener("click", (evt) =>
      showMenu(
        [
          {
            title: "Change icon…",
            icon: "shapes",
            click: () =>
              new IconPickerModal(this.app, (icon) => {
                this.draft.icon = icon;
                this.renderHead();
              }).open(),
          },
          {
            title: "Show in the ribbon",
            desc: "A button in the left sidebar that runs this action",
            icon: "panel-left",
            checked: !!this.draft.ribbon,
            click: () => (this.draft.ribbon = !this.draft.ribbon),
          },
        ],
        evt,
      ),
    );
    const name = head.createEl("input", { type: "text", cls: "quick-actions-name", placeholder: "Action name" });
    name.value = this.draft.name;
    name.addEventListener("input", () => (this.draft.name = name.value));
    head.createSpan("quick-actions-spacer");

    if (this.run) {
      const bar = head.createSpan("quick-actions-runbar");
      const last = this.lastRunIndex();
      if (this.run.status === "ok") {
        iconEl(bar, "check");
        bar.appendText(`Ran ${last === 0 ? "step 1" : `steps 1–${last + 1}`} · ${formatSeconds(this.run.ms)} · nothing written`);
      } else if (this.run.status === "cancelled") {
        bar.addClass("is-failed");
        iconEl(bar, "x");
        bar.appendText(`Cancelled at step ${last + 1}`);
      } else {
        bar.addClass("is-failed");
        iconEl(bar, "x");
        bar.appendText(`Step ${last + 1} failed`);
      }
    }
    if (this.steps.length > 0) {
      const btn = textButton(head, "play", this.run ? "Run to here" : "Test run", () => void this.runTo(this.selected + 1));
      if (this.running) btn.disabled = true;
      btn.setAttr("aria-label", "Runs the steps up to the selected one. Prompts, page fetches and models are real, and nothing is written.");
    }
    iconButton(head, "link", "Copy URI", () => copyUri(this.app, this.draft));
  }

  // ---- Rail ----

  private renderRail(): void {
    const rail = this.railEl;
    this.disposeDrag?.();
    rail.empty();
    rail.createDiv({ cls: "quick-actions-section-label", text: "Steps" });
    if (this.steps.length === 0) {
      rail.createDiv({ cls: "quick-actions-rail-empty", text: "No steps yet. Most actions start by asking for something." });
    }
    this.steps.forEach((step, i) => {
      const row = rail.createDiv("quick-actions-rail-item");
      if (i === this.selected) row.addClass("is-active");
      row.createSpan({ cls: "quick-actions-num", text: String(i + 1) });
      const icon = row.createSpan("quick-actions-step-icon");
      setIcon(icon, STEP_DEFS[step.type].icon);
      if (step.type === "llm") icon.addClass("is-llm");
      const text = row.createDiv("quick-actions-rail-text");
      text.createDiv({ cls: "quick-actions-rail-title", text: stepTitle(step, this.models) });
      this.railSub(text, step, i, row);
      row.addEventListener("click", () => this.select(i));
    });
    const add = rail.createDiv("quick-actions-rail-add");
    const btn = textButton(add, "plus", "Add step", () => showAddStepMenu(btn, (type) => this.addStep(type)), this.steps.length === 0);
    this.disposeDrag = enableDragReorder(rail, {
      itemSelector: ".quick-actions-rail-item",
      onReorder: (from, to) => this.moveStep(from, to),
    });
  }

  // The second line of a rail row: what the step produces, or what the last run captured.
  private railSub(parent: HTMLElement, step: Step, i: number, row: HTMLElement): void {
    const outs = outputsOf(step);
    const result = this.resultFor(i);
    if (!this.run) {
      if (isModelMissing(step, this.models)) {
        row.addClass("is-error");
        parent.createDiv({ cls: "quick-actions-rail-sub", text: step.model ? `Model "${step.model}" is not configured` : "No models are configured" });
        return;
      }
      const model = modelOf(step, this.models);
      const lead = step.name?.trim() && model ? `${model.name} ` : "";
      if (outs.length) parent.createDiv({ cls: "quick-actions-rail-sub", text: `${lead}→ ${outs.map((o) => o.name).join(", ")}` });
      return;
    }
    const sub = parent.createDiv("quick-actions-rail-sub is-value");
    if (result) {
      if (result.status === "ok" && result.outputs.length) {
        iconEl(sub, "check");
        const text = result.outputs.length === 1 ? `“${truncate(result.outputs[0].value, 40)}”` : `${result.outputs.length} values`;
        const value = sub.createSpan({ cls: "quick-actions-rail-value", text });
        if (STEP_DEFS[step.type].group === "generate") value.appendText(` · ${formatSeconds(result.ms)}`);
      } else if (result.status === "ok") {
        iconEl(sub, "check");
        sub.createSpan({ cls: "quick-actions-rail-value", text: result.note ?? "Done" });
      } else if (result.status === "skipped") {
        sub.createSpan({ cls: "quick-actions-rail-value", text: result.note ?? "Skipped" });
        row.addClass("is-dim");
      } else {
        sub.addClass("is-failed");
        iconEl(sub, "x");
        sub.createSpan({ cls: "quick-actions-rail-value", text: result.error ?? result.note ?? "Cancelled" });
      }
      return;
    }
    row.addClass("is-dim");
    const preview = i === this.lastRunIndex() + 1 ? STEP_DEFS[step.type].preview : undefined;
    const target = preview ? resolveStep(step, this.run.vars, resolveOptions(this.app, this.steps))[preview.key] : "";
    sub.createSpan({ cls: "quick-actions-rail-value", text: preview ? `${preview.verb} ${target}` : "Not run" });
  }

  // ---- Pane ----

  private select(i: number): void {
    this.selected = i;
    this.paneOpen = true;
    if (this.view === "run" && !this.resultFor(i)) this.view = "edit";
    this.refreshAll();
  }

  private renderPane(): void {
    const pane = this.paneEl;
    pane.empty();
    this.tracker.reset();
    this.modalEl.toggleClass("is-pane-open", this.paneOpen);
    if (this.steps.length === 0) {
      pane.addClass("is-blank");
      pane.createDiv({
        cls: "quick-actions-pane-blank",
        text: "Add a step to get started. Each step can use what the steps above it produced, and hands its own result down to the ones below.",
      });
      return;
    }
    pane.removeClass("is-blank");
    if (this.selected >= this.steps.length) this.selected = this.steps.length - 1;
    const i = this.selected;
    const step = this.steps[i];
    const def = STEP_DEFS[step.type];

    const head = pane.createDiv("quick-actions-pane-head");
    if (Platform.isPhone) {
      iconButton(head, "arrow-left", "Back to steps", () => {
        this.paneOpen = false;
        this.modalEl.removeClass("is-pane-open");
      });
    }
    head.createSpan({ cls: "quick-actions-num", text: String(i + 1) });
    const select = head.createEl("select", { cls: "dropdown" });
    for (const type of STEP_TYPES_IN_ORDER) select.createEl("option", { text: STEP_DEFS[type].verb, value: type });
    select.value = step.type;
    select.addEventListener("change", () => this.changeType(i, select.value as StepType));
    const stepName = head.createEl("input", {
      type: "text",
      cls: "quick-actions-step-name",
      placeholder: stepTitle({ ...step, name: "" }, this.models),
      attr: { "aria-label": "Step name, shown in the list and wherever this step is mentioned" },
    });
    stepName.value = step.name ?? "";
    stepName.addEventListener("input", () => {
      if (stepName.value.trim()) step.name = stepName.value;
      else delete step.name;
      this.renderRail();
    });
    const result = this.resultFor(i);
    if (result) {
      const seg = head.createSpan("quick-actions-seg");
      const edit = seg.createSpan({ text: "Edit" });
      const last = seg.createSpan({ text: "Last run" });
      (this.view === "run" ? last : edit).addClass("is-active");
      edit.addEventListener("click", () => this.setView("edit"));
      last.addEventListener("click", () => this.setView("run"));
    }
    head.createSpan("quick-actions-spacer");
    iconButton(head, "ellipsis", "More", (evt) =>
      showRowMenu(evt.currentTarget as HTMLElement, {
        extra: [{ title: "Duplicate", icon: "copy", click: () => this.duplicateStep(i) }],
        index: i,
        count: this.steps.length,
        onMove: (to) => this.moveStep(i, to),
        onDelete: () => this.deleteStep(i),
      }),
    );

    if (this.view === "run" && result) {
      this.renderRunView(pane, step, i, result);
      return;
    }

    const card = pane.createDiv("quick-actions-card");
    const inBand = card.createDiv();
    this.renderInBand(inBand, i);
    const body = card.createDiv("quick-actions-card-body");
    if (step.type === "quick_task") {
      const found = findQuickTasks(this.app);
      if ("error" in found) {
        const warning = new Setting(body)
          // eslint-disable-next-line obsidianmd/ui/sentence-case -- Quick Tasks is a plugin name
          .setName("Needs the Quick Tasks plugin")
          .setDesc(`${found.error}. Enable it and this step opens its add box and hands the new task note down.`);
        warning.settingEl.addClass("is-warning");
      }
    }
    for (const f of def.fields) {
      if (f.showIf && !f.showIf(step)) continue;
      this.renderField(body, step, f, i, inBand);
    }
    const outs = outputsOf(step);
    const band = card.createDiv("quick-actions-band is-out");
    band.createSpan({ cls: "quick-actions-band-lead", text: "Out" });
    for (const out of outs) this.outPill(band, out, i);
    const hint = outputHintOf(step);
    band.createSpan({ cls: "quick-actions-hint", text: outs.length ? `${hint} · ${this.usedByText(i)}` : hint });
  }

  // An output name in the Out band. Click to rename it, and every later use follows.
  private outPill(band: HTMLElement, out: StepOutput, i: number): void {
    const pill = renderPill(band, out.name, out.type, { cls: "is-editable" });
    pill.setAttr("contenteditable", "plaintext-only");
    pill.setAttr("spellcheck", "false");
    pill.setAttr("aria-label", "Click to rename. Every later use follows.");
    pill.addEventListener("focus", () => pill.addClass("is-edit"));
    pill.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        pill.blur();
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        pill.setText(out.name);
        pill.blur();
      }
    });
    pill.addEventListener("blur", () => {
      pill.removeClass("is-edit");
      const to = (pill.textContent ?? "").trim();
      if (to === out.name || !this.rename(i, out.name, to)) pill.setText(out.name);
    });
  }

  private rename(i: number, from: string, to: string): boolean {
    if (renameOutput(this.steps, i, from, to)) {
      this.renderRail();
      this.renderPane();
      return true;
    }
    new Notice(`Can't rename to "${to}". Use letters, digits and underscores, and a name nothing else produces.`);
    return false;
  }

  private usedByText(i: number): string {
    const consumers = consumersOf(this.steps, i);
    if (consumers.length === 0) return "not used yet";
    return "used by " + consumers.map((j) => stepLabel(this.steps[j], this.models)).join(", ");
  }

  private renderInBand(container: HTMLElement, i: number): void {
    container.empty();
    const inputs = availableInputs(this.steps, i);
    const used = new Set(usedInputs(this.steps[i]));
    renderInBand(
      container,
      inputs,
      used,
      (input) => describeInput(input, this.steps, this.models),
      (name) => this.tracker.insert(name),
      i === 0 ? "first step, nothing from above yet" : undefined,
    );
  }

  private renderField(body: HTMLElement, step: Step, f: FieldDef, i: number, inBand: HTMLElement): void {
    const record = step as unknown as Record<string, unknown>;
    const setting = new Setting(body).setName(f.label);
    // A control its model can't use is off, and says why in place of its description.
    const reason = f.unavailable?.(step, this.models);
    const desc = reason ?? f.desc;
    if (desc) setting.setDesc(desc);
    const edited = () => this.renderInBand(inBand, i);
    switch (f.kind) {
      case "text":
        setting.addText((t) =>
          t
            .setPlaceholder(f.placeholder ?? "")
            .setValue(String(record[f.key] ?? ""))
            .onChange((v) => (record[f.key] = v)),
        );
        return;
      case "toggle":
        setting.addToggle((t) =>
          t
            .setDisabled(reason !== undefined)
            .setValue(Boolean(record[f.key]))
            .onChange((v) => {
              const changed = this.changeOutputs(i, step, () => (record[f.key] = v));
              if (!changed && STEP_DEFS[step.type].fields.some((other) => other.showIf)) this.renderPane();
            }),
        );
        return;
      case "dropdown":
        setting.addDropdown((d) => {
          for (const o of f.options ?? []) d.addOption(o.value, o.label);
          d.setDisabled(reason !== undefined)
            .setValue(String(record[f.key] ?? ""))
            .onChange((v) => (record[f.key] = v));
        });
        return;
      case "model":
        this.renderModel(setting, step, i);
        return;
      case "folder":
        setting.addText((t) => {
          t.setPlaceholder(f.placeholder ?? "")
            .setValue(String(record[f.key] ?? ""))
            .onChange((v) => {
              record[f.key] = v;
              edited();
            });
          new FolderSuggest(this.app, t.inputEl);
        });
        return;
      case "options":
        this.renderOptions(setting, step);
        return;
      case "outputs":
        this.renderOutputs(setting, step, i);
        return;
      case "line":
      case "file":
      case "block": {
        const multiline = f.kind === "block";
        if (multiline) setting.settingEl.addClass("is-stacked");
        const available = () => new Set(availableInputs(this.steps, i).map((a) => a.name));
        const field = createPillField(setting.controlEl, {
          value: String(record[f.key] ?? ""),
          multiline,
          mono: f.mono,
          placeholder: f.placeholder,
          toolsParent: setting.nameEl,
          resolve: (name) => {
            const input = availableInputs(this.steps, i).find((a) => a.name === name);
            return input ? { type: input.type } : null;
          },
          onChange: (v) => {
            record[f.key] = v;
            edited();
          },
          onFocus: () => (this.tracker.current = field),
        });
        attachVarPicker(this.app, field, () => this.pickerItems(i, available()));
        this.tracker.register(field);
        return;
      }
    }
  }

  // The configured models, plus the one the step names when that one is gone. Picking a model resets
  // the values it can't take, such as Haiku's effort.
  private renderModel(setting: Setting, step: Step, i: number): void {
    if (step.type !== "llm") return;
    setting.addDropdown((d) => {
      d.addOption("", this.models.length ? `(first model: ${this.models[0].name})` : "(no models configured)");
      for (const m of this.models) d.addOption(m.name, m.name);
      if (step.model && isModelMissing(step, this.models)) {
        d.addOption(step.model, `${step.model} · not configured`);
        setting.settingEl.addClass("is-warning");
        setting.setDesc("This model was renamed or deleted. Pick one, or the step stops the action.");
      }
      d.setValue(step.model).onChange((v) => {
        const changed = this.changeOutputs(i, step, () => {
          step.model = v;
          Object.assign(step, withoutUnavailable(step, this.models));
        });
        if (!changed) {
          this.renderRail();
          this.renderPane();
        }
      });
    });
  }

  // Makes a change to step i that can add or remove outputs. An added output gets a name nothing
  // else produces, and a removed one that later steps use raises a notice. Redraws and returns true
  // when the outputs changed.
  private changeOutputs(i: number, step: Step, change: () => void): boolean {
    const before = outputsOf(step).map((o) => o.name);
    change();
    if (outputsOf(step).length > before.length) freshOutputs(step, producedNames(this.steps.filter((s) => s !== step)));
    const after = outputsOf(step).map((o) => o.name);
    const lost = before.filter((name) => !after.includes(name) && consumersOf(this.steps, i, name).length > 0);
    if (lost.length) new Notice(lostSource(lost));
    if (before.join() === after.join()) return false;
    this.renderRail();
    this.renderPane();
    return true;
  }

  // The reorderable option list of a Choice step.
  private renderOptions(setting: Setting, step: Step): void {
    if (step.type !== "choice") return;
    setting.settingEl.addClass("is-stacked");
    const list = setting.controlEl.createDiv("quick-actions-options");
    const render = () => {
      list.empty();
      step.options.forEach((option, k) => {
        const row = list.createDiv("quick-actions-option");
        const grip = row.createSpan("quick-actions-grip");
        setIcon(grip, "grip-vertical");
        const input = row.createEl("input", { type: "text", placeholder: `Option ${k + 1}` });
        input.value = option;
        input.addEventListener("input", () => (step.options[k] = input.value));
        iconButton(row, "x", "Remove", () => {
          step.options.splice(k, 1);
          render();
        });
      });
      const add = list.createDiv();
      textButton(add, "plus", "Add option", () => {
        step.options.push("");
        render();
        const inputs = list.querySelectorAll("input");
        inputs[inputs.length - 1]?.focus();
      });
    };
    render();
    enableDragReorder(list, {
      itemSelector: ".quick-actions-option",
      handleSelector: ".quick-actions-grip",
      onReorder: (from, to) => {
        moveItem(step.options, from, to);
        render();
      },
    });
  }

  // A model step's reply: one value, or several fields the model fills in one call.
  private renderOutputs(setting: Setting, step: Step, i: number): void {
    if (step.type !== "llm") return;
    const several = step.outputs.length > 0;
    setting.setDesc(several ? "The model fills in each field in one call, and each becomes its own value." : "The whole reply becomes one value.");
    setting.addDropdown((d) =>
      d
        .addOption("one", "One value")
        .addOption("several", "Several values")
        .setValue(several ? "several" : "one")
        .onChange((v) => {
          if (v === "several") {
            step.outputs = [{ name: step.variable, desc: "", choices: [] }];
          } else {
            const kept = step.outputs.find((o) => o.name === step.variable) ? step.variable : (step.outputs[0]?.name ?? step.variable);
            const lost = step.outputs.filter((o) => o.name !== kept && consumersOf(this.steps, i, o.name).length > 0);
            step.variable = kept;
            step.outputs = [];
            if (lost.length) new Notice(lostSource(lost.map((o) => o.name)));
          }
          this.renderRail();
          this.renderPane();
        }),
    );
    if (!several) return;
    setting.settingEl.addClass("is-stacked", "is-outputs");
    const list = setting.controlEl.createDiv("quick-actions-outputs");
    step.outputs.forEach((out: LLMOutput, k) => {
      const row = list.createDiv("quick-actions-output-row");
      const name = row.createEl("input", { type: "text", cls: "quick-actions-mono", placeholder: "name", attr: { "aria-label": "Value name" } });
      name.value = out.name;
      name.addEventListener("change", () => {
        const to = name.value.trim();
        if (to !== out.name && !this.rename(i, out.name, to)) name.value = out.name;
      });
      const desc = row.createEl("input", { type: "text", placeholder: "What the model should put here", attr: { "aria-label": "Description" } });
      desc.value = out.desc;
      desc.addEventListener("input", () => (out.desc = desc.value));
      const choices = row.createEl("input", { type: "text", placeholder: "Choices, comma separated (optional)", attr: { "aria-label": "Choices" } });
      choices.value = out.choices.join(", ");
      choices.addEventListener("input", () => (out.choices = choices.value.split(",").map((c) => c.trim()).filter((c) => c !== "")));
      if (step.outputs.length > 1) {
        iconButton(row, "x", "Remove", () => {
          const used = consumersOf(this.steps, i, out.name).length > 0;
          step.outputs.splice(k, 1);
          if (used) new Notice(lostSource([out.name]));
          this.renderRail();
          this.renderPane();
        });
      }
    });
    textButton(list.createDiv(), "plus", "Add value", () => {
      step.outputs.push({ name: uniqueName("value", producedNames(this.steps)), desc: "", choices: [] });
      this.renderRail();
      this.renderPane();
    });
  }

  // Everything the picker can offer at step i: available inputs, then later outputs greyed out.
  private pickerItems(i: number, available: Set<string>): VarItem[] {
    const items: VarItem[] = [];
    const vars = this.run ? this.varsBefore(i) : {};
    for (const input of availableInputs(this.steps, i)) {
      if (input.from < 0) continue;
      items.push({
        name: input.name,
        type: input.type,
        source: describeInput(input, this.steps, this.models),
        sample: vars[input.name] !== undefined ? `“${truncate(vars[input.name], 60)}”` : undefined,
      });
    }
    for (const b of BUILTINS) items.push({ name: b.name, type: b.type, source: b.source, sample: vars[b.name] ?? b.sample, builtin: true });
    for (let j = i; j < this.steps.length; j++) {
      for (const out of outputsOf(this.steps[j])) {
        if (available.has(out.name)) continue;
        items.push({
          name: out.name,
          type: out.type,
          source: `Step ${j + 1} · ${stepTitle(this.steps[j], this.models)}`,
          unavailable: j === i ? "this step's own output" : "runs after this step",
        });
      }
    }
    return items;
  }

  // ---- Last run view ----

  private setView(view: "edit" | "run"): void {
    this.view = view;
    this.renderPane();
  }

  // Values as they were before step i ran: built-ins plus outputs of earlier steps.
  private varsBefore(i: number): Record<string, string> {
    const vars: Record<string, string> = {};
    if (!this.run) return vars;
    for (const b of BUILTINS) if (this.run.vars[b.name] !== undefined) vars[b.name] = this.run.vars[b.name];
    for (const r of this.run.steps) {
      if (r.index < i) for (const o of r.outputs) vars[o.name] = o.value;
    }
    return vars;
  }

  private renderRunView(pane: HTMLElement, step: Step, i: number, result: StepResult): void {
    const vars = this.varsBefore(i);
    const opts = resolveOptions(this.app, this.steps);
    const label = (text: string) => pane.createDiv({ cls: "quick-actions-result-label", text });
    const marked = (template: string, cls = "", mode: ResolveMode = "plain") => {
      const box = pane.createDiv(`quick-actions-result ${cls}`.trim());
      for (const seg of resolveSegments(template, vars, opts, mode)) {
        if (seg.name) box.createEl("mark", { text: seg.text });
        else box.appendText(seg.text);
      }
      return box;
    };
    const muted = (text: string) => pane.createDiv({ cls: "quick-actions-result is-muted", text });

    if (step.type === "llm") {
      const model = modelOf(step, this.models)?.name ?? (step.model || "the model");
      if (step.system_prompt) {
        label(`System prompt for ${model}`);
        marked(step.system_prompt, "is-muted");
      }
      label(`Prompt sent to ${model}`);
      marked(step.user_prompt);
      if (result.note) muted(result.note);
    } else if (step.type === "fetch_page") {
      label("Fetched");
      marked(step.url, "is-muted");
    } else if (step.type === "create_file") {
      label(result.status === "ok" ? "Would create" : "Path");
      muted(result.resolved.path ?? step.path);
      label("Content");
      marked(step.content, step.content.includes("---") ? "is-mono" : "", "note");
    } else if (step.type === "insert_in_section") {
      if (result.preview) {
        label("Would insert into ").createSpan({ cls: "quick-actions-result-path", text: result.resolved.target });
        this.renderInsertPreview(pane, result.preview);
      } else {
        label("Would insert into");
        marked(`${step.target} under ${step.section}`, "is-muted");
        label("Text");
        marked(step.format);
      }
    } else if (step.type === "open_file") {
      label("Would open");
      muted(result.resolved.target ?? step.target);
    } else if (step.type === "quick_task" && result.note) {
      label("Would create");
      muted(result.note);
    }

    if (result.error) {
      label("Failed");
      pane.createDiv({ cls: "quick-actions-result is-error", text: result.error });
    } else if (result.outputs.length) {
      for (const out of result.outputs) {
        const l = label("Produced");
        renderPill(l, out.name, out.type);
        pane.createDiv({ cls: "quick-actions-result is-output", text: out.value || "(empty)" });
      }
    } else if (result.note && step.type !== "quick_task") {
      muted(result.note);
    }

    const next = this.steps[i + 1];
    const nextPreview = next ? STEP_DEFS[next.type].preview : undefined;
    if (next && nextPreview) {
      label("Next step");
      const template = (next as unknown as Record<string, string>)[nextPreview.key];
      const mode = STEP_DEFS[next.type].fields.find((f) => f.key === nextPreview.key)?.resolve;
      marked(template, "is-muted", mode).prepend(createSpan({ text: `${nextPreview.verb} ` }));
    }

    const actions = pane.createDiv("quick-actions-run-actions");
    if (i === this.lastRunIndex() && next && this.run?.status === "ok") {
      const btn = textButton(actions, "play", `Run step ${i + 2} too`, () => void this.runTo(i + 2, i + 1));
      if (this.running) btn.disabled = true;
    }
    actions.createEl("button", { text: "Discard run" }).addEventListener("click", () => {
      this.clearRun();
      this.refreshAll();
    });
  }

  // The lines around the insert point as they will read, the new text marked with +.
  private renderInsertPreview(pane: HTMLElement, p: InsertPreview): void {
    const box = pane.createDiv("quick-actions-result quick-actions-diff");
    p.lines.forEach((line, k) => {
      const added = k >= p.added && k < p.added + p.count;
      const row = box.createDiv(added ? "quick-actions-diff-line is-added" : "quick-actions-diff-line");
      const number = added ? "+" : String(p.start + k + 1 - (k >= p.added + p.count ? p.count : 0));
      row.createSpan({ cls: "quick-actions-diff-num", text: number });
      row.createSpan({ cls: "quick-actions-diff-text", text: line || " " });
    });
  }

  // ---- Test run ----

  // Runs on a copy of the draft, so editing during a model call can't change the steps it runs.
  // When the steps changed meanwhile, the results are dropped.
  private async runTo(end: number, from = 0): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.runGen;
    this.renderHead();
    const action = JSON.parse(JSON.stringify(this.draft)) as Action;
    const progress = new RunProgress(`Test run of ${action.name || "this action"}`, action.steps.length, this.models);
    const result = await runAction(this.app, action, this.models, {
      write: false,
      from,
      to: end,
      vars: from > 0 && this.run ? this.run.vars : undefined,
      onStep: (e) => progress.step(e),
      cancelled: () => progress.cancelled,
    });
    progress.hide();
    if (this.closed) return;
    this.running = false;
    if (gen !== this.runGen) {
      this.renderHead();
      return;
    }
    if (from > 0 && this.run) {
      this.run = {
        steps: [...this.run.steps.filter((r) => r.index < from), ...result.steps],
        vars: result.vars,
        status: result.status,
        ms: this.run.ms + result.ms,
      };
    } else {
      this.run = result;
    }
    const last = result.steps[result.steps.length - 1];
    if (last?.error) new Notice(`Step ${last.index + 1} failed: ${last.error}`);
    this.view = this.resultFor(this.selected) ? "run" : "edit";
    this.refreshAll();
  }

  // ---- Step operations (structural changes clear the run) ----

  private clearRun(): void {
    this.run = null;
    this.view = "edit";
    this.runGen++;
  }

  private refreshAll(): void {
    this.renderHead();
    this.renderRail();
    this.renderPane();
  }

  private addStep(type: StepType): void {
    this.steps.push(freshOutputs(makeStep(type), producedNames(this.steps)));
    this.clearRun();
    this.select(this.steps.length - 1);
  }

  private changeType(i: number, type: StepType): void {
    const taken = producedNames(this.steps.filter((_, j) => j !== i));
    this.steps[i] = convertStep(this.steps[i], type, taken);
    this.clearRun();
    this.refreshAll();
  }

  private duplicateStep(i: number): void {
    const copy = freshOutputs(JSON.parse(JSON.stringify(this.steps[i])) as Step, producedNames(this.steps));
    this.steps.splice(i + 1, 0, copy);
    this.clearRun();
    this.select(i + 1);
  }

  private deleteStep(i: number): void {
    const outs = outputsOf(this.steps[i]).map((o) => o.name);
    const lost = consumersOf(this.steps, i).length > 0;
    this.steps.splice(i, 1);
    if (lost) new Notice(`Step ${i + 1} deleted. ${lostSource(outs)}`);
    this.selected = Math.max(0, Math.min(i, this.steps.length - 1));
    this.paneOpen = false;
    this.clearRun();
    this.refreshAll();
  }

  private moveStep(from: number, to: number): void {
    moveItem(this.steps, from, to);
    this.selected = to;
    this.clearRun();
    this.refreshAll();
  }
}
