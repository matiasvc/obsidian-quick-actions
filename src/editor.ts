import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { Action, Step, StepType } from "./types";
import QuickActionsPlugin from "./main";
import { FieldDef, STEP_DEFS, STEP_TYPES_IN_ORDER, convertStep, makeStep, outputOf, stepTitle } from "./steps";
import {
  BUILTINS,
  availableInputs,
  consumersOf,
  producedNames,
  renameOutput,
  resolveSegments,
  resolveStep,
  uniqueName,
  usedInputs,
} from "./variables";
import { RunResult, StepResult, runAction } from "./executor";
import { FolderSuggest } from "./suggest";
import { PillField, createPillField } from "./pillfield";
import { VarItem, attachVarPicker } from "./varpicker";
import { FieldFocusTracker, copyUri, describeInput, formatSeconds, iconButton, iconEl, renderInBand, renderPill, textButton, truncate } from "./ui";
import { showAddStepMenu, showRowMenu } from "./menus";
import { enableDragReorder, moveItem } from "./dragreorder";

// What a "Do" step would do, phrased for a step that has not run yet.
function previewOf(step: Step): { verb: string; key: string } | null {
  switch (step.type) {
    case "create_file":
      return { verb: "Would create", key: "path" };
    case "insert_in_section":
      return { verb: "Would insert into", key: "target" };
    case "open_file":
      return { verb: "Would open", key: "target" };
    default:
      return null;
  }
}

const BUILTIN_SAMPLES: Record<string, { source: string; sample: string }> = {
  date: { source: "Today", sample: "2026-09-04" },
  time: { source: "Now", sample: "13:52" },
  timestamp: { source: "Now, for filenames", sample: "20260904135200" },
};

export class ActionEditModal extends Modal {
  private plugin: QuickActionsPlugin;
  private draft: Action;
  private onSave: (action: Action) => void;
  private selected = 0;
  private run: RunResult | null = null;
  private view: "edit" | "run" = "edit";
  private running = false;
  private closed = false;
  private tracker = new FieldFocusTracker();
  private fields: PillField[] = [];
  private headEl: HTMLElement;
  private railEl: HTMLElement;
  private paneEl: HTMLElement;
  private disposeDrag: (() => void) | null = null;

  constructor(app: App, plugin: QuickActionsPlugin, source: Action, onSave: (action: Action) => void) {
    super(app);
    this.plugin = plugin;
    this.draft = JSON.parse(JSON.stringify(source));
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("quick-actions-editor");
    this.headEl = contentEl.createDiv("quick-actions-editor-head");
    const split = contentEl.createDiv("quick-actions-split");
    this.railEl = split.createDiv("quick-actions-rail");
    this.paneEl = split.createDiv("quick-actions-pane");
    const footer = contentEl.createDiv("quick-actions-footer");
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.save());
    this.scope.register(["Mod"], "Enter", () => {
      this.save();
      return false;
    });
    this.renderHead();
    this.renderRail();
    this.renderPane();
  }

  onClose(): void {
    this.closed = true;
    this.disposeDrag?.();
    this.contentEl.empty();
  }

  private save(): void {
    this.onSave(this.draft);
    this.close();
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
      btn.setAttr("aria-label", "Runs the steps up to the selected one. Prompts and models are real, nothing is written.");
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

  // The second line of a rail row: the output name, or what the last run captured.
  private railSub(parent: HTMLElement, step: Step, i: number, row: HTMLElement): void {
    const out = outputOf(step);
    const result = this.resultFor(i);
    if (!this.run) {
      if (out) parent.createDiv({ cls: "quick-actions-rail-sub", text: `→ ${out.name}` });
      return;
    }
    const sub = parent.createDiv("quick-actions-rail-sub is-value");
    if (result) {
      if (result.status === "ok" && result.output) {
        iconEl(sub, "check");
        const value = sub.createSpan({ cls: "quick-actions-rail-value", text: `“${truncate(result.output.value, 40)}”` });
        if (step.type === "llm") value.appendText(` · ${formatSeconds(result.ms)}`);
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
    const preview = i === this.lastRunIndex() + 1 ? previewOf(step) : null;
    sub.createSpan({ cls: "quick-actions-rail-value", text: preview ? `${preview.verb} ${resolveStep(step, this.run.vars)[preview.key]}` : "Not run" });
  }

  // ---- Pane ----

  private select(i: number): void {
    this.selected = i;
    if (this.view === "run" && !this.resultFor(i)) this.view = "edit";
    this.renderHead();
    this.renderRail();
    this.renderPane();
  }

  private renderPane(): void {
    const pane = this.paneEl;
    pane.empty();
    this.fields = [];
    this.tracker.reset();
    if (this.steps.length === 0) {
      pane.addClass("is-blank");
      pane.createDiv({
        cls: "quick-actions-pane-blank",
        text: "Add a step on the left. Each step can use what the steps above it produced, and hands its own result down to the ones below.",
      });
      return;
    }
    pane.removeClass("is-blank");
    if (this.selected >= this.steps.length) this.selected = this.steps.length - 1;
    const i = this.selected;
    const step = this.steps[i];
    const def = STEP_DEFS[step.type];

    const head = pane.createDiv("quick-actions-pane-head");
    head.createSpan({ cls: "quick-actions-num", text: String(i + 1) });
    const select = head.createEl("select", { cls: "dropdown" });
    for (const type of STEP_TYPES_IN_ORDER) select.createEl("option", { text: STEP_DEFS[type].verb, value: type });
    select.value = step.type;
    select.addEventListener("change", () => this.changeType(i, select.value as StepType));
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
    if (step.type === "tasks_modal") {
      new Setting(body)
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- Tasks is a plugin name
        .setName("Opens the Tasks plugin dialog")
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- Tasks is a plugin name
        .setDesc("The task line it builds becomes this step's output. Nothing to configure. Needs the Tasks plugin.");
    }
    for (const f of def.fields) {
      if (f.showIf && !f.showIf(step)) continue;
      this.renderField(body, step, f, i, inBand);
    }
    const out = outputOf(step);
    const band = card.createDiv("quick-actions-band is-out");
    band.createSpan({ cls: "quick-actions-band-lead", text: "Out" });
    if (out) {
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
        if (to === out.name) {
          pill.setText(out.name);
          return;
        }
        if (renameOutput(this.steps, i, to)) {
          this.renderRail();
          this.renderPane();
        } else {
          pill.setText(out.name);
          new Notice(`Can't rename to "${to}": use letters, digits and underscores, and a name no other step produces.`);
        }
      });
      band.createSpan({ cls: "quick-actions-hint", text: `${def.outputHint} · ${this.usedByText(i)}` });
    } else {
      band.createSpan({ cls: "quick-actions-hint", text: def.outputHint });
    }
  }

  private usedByText(i: number): string {
    const consumers = consumersOf(this.steps, i);
    if (consumers.length === 0) return "not used yet";
    return "used by " + consumers.map((j) => stepTitle(this.steps[j], this.models)).join(", ");
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
    if (f.desc) setting.setDesc(f.desc);
    const edited = () => {
      this.renderInBand(inBand, i);
      for (const field of this.fields) field.refresh();
    };
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
          t.setValue(Boolean(record[f.key])).onChange((v) => {
            record[f.key] = v;
            if (STEP_DEFS[step.type].fields.some((other) => other.showIf)) this.renderPane();
          }),
        );
        return;
      case "dropdown":
        setting.addDropdown((d) => {
          if (step.type === "llm" && f.key === "model") {
            d.addOption("", this.models.length ? `(first model: ${this.models[0].name})` : "(no models configured)");
            for (const m of this.models) d.addOption(m.name, m.name);
          } else {
            for (const o of f.options ?? []) d.addOption(o.value, o.label);
          }
          d.setValue(String(record[f.key] ?? "")).onChange((v) => {
            record[f.key] = v;
            if (step.type === "llm") this.renderRail();
          });
        });
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
        this.fields.push(field);
        this.tracker.register(field);
        return;
      }
    }
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
    for (const b of BUILTINS) {
      items.push({ name: b.name, type: b.type, source: BUILTIN_SAMPLES[b.name]?.source ?? "Always available", sample: vars[b.name] ?? BUILTIN_SAMPLES[b.name]?.sample, builtin: true });
    }
    for (let j = i; j < this.steps.length; j++) {
      const out = outputOf(this.steps[j]);
      if (!out || available.has(out.name)) continue;
      items.push({
        name: out.name,
        type: out.type,
        source: `Step ${j + 1} · ${stepTitle(this.steps[j], this.models)}`,
        unavailable: j === i ? "this step's own output" : "runs after this step",
      });
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
      if (r.index < i && r.output) vars[r.output.name] = r.output.value;
    }
    return vars;
  }

  private renderRunView(pane: HTMLElement, step: Step, i: number, result: StepResult): void {
    const vars = this.varsBefore(i);
    const label = (text: string) => pane.createDiv({ cls: "quick-actions-result-label", text });
    const marked = (template: string, cls = "") => {
      const box = pane.createDiv(`quick-actions-result ${cls}`.trim());
      for (const seg of resolveSegments(template, vars)) {
        if (seg.name) box.createEl("mark", { text: seg.text });
        else box.appendText(seg.text);
      }
      return box;
    };

    if (step.type === "llm") {
      const model = stepTitle(step, this.models);
      if (step.system_prompt) {
        label(`System prompt for ${model}`);
        marked(step.system_prompt, "is-muted");
      }
      label(`Prompt sent to ${model}`);
      marked(step.user_prompt);
    } else if (step.type === "create_file") {
      label(result.status === "ok" ? "Would create" : "Path");
      marked(step.path, "is-muted");
      label("Content");
      marked(step.content, step.content.includes("---") ? "is-mono" : "");
    } else if (step.type === "insert_in_section") {
      label("Would insert into");
      marked(`${step.target} under ${step.section}`, "is-muted");
      label("Text");
      marked(step.format);
    } else if (step.type === "open_file") {
      label("Would open");
      marked(step.target, "is-muted");
    }

    if (result.error) {
      label("Failed");
      pane.createDiv({ cls: "quick-actions-result is-error", text: result.error });
    } else if (result.output) {
      const l = label("Produced");
      renderPill(l, result.output.name, result.output.type);
      pane.createDiv({ cls: "quick-actions-result is-output", text: result.output.value });
    } else if (result.note) {
      pane.createDiv({ cls: "quick-actions-result is-muted", text: result.note });
    }

    const next = this.steps[i + 1];
    const nextPreview = next ? previewOf(next) : null;
    if (next && nextPreview) {
      label("Next step");
      const template = (next as unknown as Record<string, string>)[nextPreview.key];
      marked(template, "is-muted").prepend(createSpan({ text: `${nextPreview.verb} ` }));
    }

    const actions = pane.createDiv("quick-actions-run-actions");
    if (i === this.lastRunIndex() && next && this.run?.status === "ok") {
      const btn = textButton(actions, "play", `Run step ${i + 2} too`, () => void this.runTo(i + 2, i + 1));
      if (this.running) btn.disabled = true;
    }
    actions.createEl("button", { text: "Discard run" }).addEventListener("click", () => {
      this.run = null;
      this.view = "edit";
      this.renderHead();
      this.renderRail();
      this.renderPane();
    });
  }

  // ---- Test run ----

  private async runTo(end: number, from = 0): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.renderHead();
    const vars = from > 0 && this.run ? this.run.vars : undefined;
    const result = await runAction(this.app, this.draft, this.models, { write: false, from, to: end, vars });
    if (this.closed) return;
    this.running = false;
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
    this.renderHead();
    this.renderRail();
    this.renderPane();
  }

  // ---- Step operations (structural changes clear the run) ----

  private clearRun(): void {
    this.run = null;
    this.view = "edit";
  }

  private refreshAll(): void {
    this.renderHead();
    this.renderRail();
    this.renderPane();
  }

  private addStep(type: StepType): void {
    const step = makeStep(type);
    if ("variable" in step) step.variable = uniqueName(step.variable, producedNames(this.steps));
    this.steps.push(step);
    this.selected = this.steps.length - 1;
    this.clearRun();
    this.refreshAll();
  }

  private changeType(i: number, type: StepType): void {
    const taken = producedNames(this.steps.filter((_, j) => j !== i));
    this.steps[i] = convertStep(this.steps[i], type, taken);
    this.clearRun();
    this.refreshAll();
  }

  private duplicateStep(i: number): void {
    const copy: Step = JSON.parse(JSON.stringify(this.steps[i]));
    if ("variable" in copy) copy.variable = uniqueName(copy.variable, producedNames(this.steps));
    this.steps.splice(i + 1, 0, copy);
    this.selected = i + 1;
    this.clearRun();
    this.refreshAll();
  }

  private deleteStep(i: number): void {
    const out = outputOf(this.steps[i]);
    const consumers = consumersOf(this.steps, i);
    this.steps.splice(i, 1);
    if (out && consumers.length > 0) {
      const names = consumers.map((j) => `${j} ${stepTitle(this.steps[j - 1], this.models)}`).join(", ");
      new Notice(`Step ${i + 1} deleted. Steps ${names} still use {{${out.name}}} and now need a new source.`);
    }
    this.selected = Math.max(0, Math.min(i, this.steps.length - 1));
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
