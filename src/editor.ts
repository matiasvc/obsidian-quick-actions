import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { Action, ElseIfStep, IfStep, LLMOutput, Step, StepType, TestOp } from "./types";
import QuickActionsPlugin from "./main";
import {
  CONVERTIBLE_TYPES,
  FieldDef,
  ResolveMode,
  STEP_DEFS,
  StepEnv,
  StepOutput,
  blockedReason,
  convertStep,
  freshOutputs,
  isModelMissing,
  makeStep,
  modelOf,
  newTest,
  outputHintOf,
  outputsOf,
  stepLabel,
  stepTitle,
  templatedFields,
  withoutUnavailable,
} from "./steps";
import {
  Block,
  TEST_OPS,
  blockOfMarker,
  blocksOf,
  branchEnd,
  isMarker,
  moveSteps,
  moveTo,
  placeOf,
  removeBranch,
  spanEnd,
  stepCount,
  stepNumbers,
  unwrapBlock,
} from "./flow";
import {
  BUILTINS,
  InputInfo,
  availableInputs,
  consumersOf,
  copySteps,
  formatRef,
  producedNames,
  renameOutput,
  resolveSegments,
  resolveStep,
  scopeBefore,
  takenNames,
  usedInputs,
} from "./variables";
import { InsertPreview } from "./insert";
import { RunResult, StepResult, resolveOptions, runAction } from "./executor";
import { RunProgress } from "./progress";
import { FolderSuggest } from "./suggest";
import { createPillField } from "./pillfield";
import { VarItem, attachVarPicker } from "./varpicker";
import { FieldFocusTracker, copyUri, describeInput, formatSeconds, iconButton, iconEl, plural, renderInBand, renderPill, textButton, truncate } from "./ui";
import { MenuEntry, showAddStepMenu, showMenu, showRowMenu } from "./menus";
import { enableDragReorder, moveItem } from "./dragreorder";
import { IconPickerModal } from "./modals";

// A notice for values that later steps read and no step produces any more.
function lostSource(names: string[]): string {
  return `Later steps still use ${names.map((n) => formatRef(n)).join(", ")} and now need a new source.`;
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
  // Bumped by every structural change (clearRun), so a test run still going knows its results are stale.
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
  // One per step, so a keystroke in a step's name or tests redraws its row and not the whole rail.
  private railRows: HTMLElement[] = [];
  // What the selected step can use. Only a change that redraws the pane can change it.
  private paneInputs: InputInfo[] = [];
  // The names the In band shows as used, so a field edit redraws it only when they change.
  private inBandUsed = "";
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

  private get env(): StepEnv {
    return { app: this.app, models: this.models };
  }

  private resultFor(index: number): StepResult | undefined {
    return this.run?.steps.find((r) => r.index === index);
  }

  // The last step the run reached, leaving out steps in branches it skipped.
  private lastRunIndex(): number {
    return this.run ? Math.max(-1, ...this.run.steps.filter((r) => r.status !== "skipped").map((r) => r.index)) : -1;
  }

  // ---- Header ----

  private renderHead(): void {
    const head = this.headEl;
    head.empty();
    iconButton(
      head,
      this.draft.icon,
      "Icon and ribbon button",
      (evt) =>
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
      "quick-actions-action-icon",
    );
    const name = head.createEl("input", { type: "text", cls: "quick-actions-name", placeholder: "Action name" });
    name.value = this.draft.name;
    name.addEventListener("input", () => (this.draft.name = name.value));
    head.createSpan("quick-actions-spacer");

    if (this.run) {
      const bar = head.createSpan("quick-actions-runbar");
      const last = stepNumbers(this.steps)[this.lastRunIndex()] ?? 0;
      if (this.run.status === "ok" || this.run.status === "stopped") {
        iconEl(bar, "check");
        const stopped = this.run.status === "stopped" ? `Stopped at step ${last}` : `Ran ${last === 1 ? "step 1" : `steps 1–${last}`}`;
        bar.appendText(`${stopped} · ${formatSeconds(this.run.ms)} · nothing written`);
      } else {
        bar.addClass("is-failed");
        iconEl(bar, "x");
        bar.appendText(this.run.status === "cancelled" ? `Cancelled at step ${last}` : `Step ${last} failed`);
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

  // Every step is one row, so rows and steps share indices. An If block is a framed box: its if
  // is the header, each else_if and else a divider, and its end_if the bottom edge.
  private renderRail(): void {
    const rail = this.railEl;
    this.disposeDrag?.();
    rail.empty();
    rail.createDiv({ cls: "quick-actions-section-label", text: "Steps" });
    if (this.steps.length === 0) {
      rail.createDiv({ cls: "quick-actions-rail-empty", text: "No steps yet. Most actions start by asking for something." });
    }
    const numbers = stepNumbers(this.steps);
    const blocks = blocksOf(this.steps);
    this.railRows = this.steps.map((_, i) => rail.appendChild(this.railRow(i, numbers, blocks)));
    const add = rail.createDiv("quick-actions-rail-add");
    const btn = textButton(add, "plus", "Add step", () => showAddStepMenu(btn, (type) => this.addStep(type)), this.steps.length === 0);
    this.disposeDrag = enableDragReorder(rail, {
      itemSelector: ".quick-actions-rail-item",
      canDrag: (item) => !item.hasClass("is-fixed"),
      onReorder: (from, to) => this.moveStep(from, to),
    });
  }

  private railRow(i: number, numbers: number[], blocks: Map<number, Block>): HTMLElement {
    const step = this.steps[i];
    const depth = [...blocks.values()].filter((b) => b.start < i && i < b.end).length;
    const row = createDiv("quick-actions-rail-item");
    row.style.setProperty("--depth", String(depth));
    if (depth > 0) row.addClass("is-in-block");
    if (isMarker(step)) {
      this.railMarker(row, step, i, blocks);
      return row;
    }
    if (i === this.selected) row.addClass("is-active");
    if (step.type === "if") row.addClass("is-block-head");
    row.createSpan({ cls: "quick-actions-num", text: String(numbers[i]) });
    const icon = row.createSpan("quick-actions-step-icon");
    setIcon(icon, STEP_DEFS[step.type].icon);
    if (step.type === "llm") icon.addClass("is-llm");
    if (step.type === "if") icon.addClass("is-if");
    const text = row.createDiv("quick-actions-rail-text");
    text.createDiv({ cls: "quick-actions-rail-title", text: stepTitle(step, this.models) });
    this.railSub(text, step, i, row, blocks.get(i));
    row.addEventListener("click", () => this.select(i));
    return row;
  }

  // Redraws one row after an edit that changes only that step's title or second line.
  private refreshRailRow(i: number): void {
    const old = this.railRows[i];
    if (!old) return;
    const row = this.railRow(i, stepNumbers(this.steps), blocksOf(this.steps));
    old.replaceWith(row);
    this.railRows[i] = row;
  }

  // A block's divider or bottom edge. Neither can be dragged, but steps can be dropped next to
  // them, and clicking one opens the block.
  private railMarker(row: HTMLElement, step: Step, i: number, blocks: Map<number, Block>): void {
    row.addClass("is-fixed", step.type === "end_if" ? "is-block-end" : "is-block-branch");
    const block = blockOfMarker(this.steps, i, blocks);
    if (block) row.addEventListener("click", () => this.select(block.start));
    if (step.type === "end_if") return;
    row.createSpan({ cls: "quick-actions-branch-label", text: stepTitle(step, this.models) });
    const ran = block ? this.resultFor(block.start)?.branch : undefined;
    if (ran !== undefined) row.createSpan({ cls: "quick-actions-branch-run", text: ran === i ? "ran" : "not taken" });
  }

  // The second line of a rail row: what the step produces, or what the last run captured. `block`
  // is the step's block when it is an if.
  private railSub(parent: HTMLElement, step: Step, i: number, row: HTMLElement, block?: Block): void {
    const outs = outputsOf(step);
    const result = this.resultFor(i);
    if (!this.run && block) {
      const inside = stepCount(this.steps.slice(i + 1, block.end));
      parent.createDiv({ cls: "quick-actions-rail-sub", text: `${plural(block.branches.length, "branch", "branches")} · ${plural(inside, "step", "steps")}` });
      return;
    }
    if (!this.run) {
      const blocked = blockedReason(step, this.env);
      if (blocked) {
        row.addClass("is-error");
        parent.createDiv({ cls: "quick-actions-rail-sub", text: blocked });
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
        if (step.type === "llm" || step.type === "fetch_page") value.appendText(` · ${formatSeconds(result.ms)}`);
      } else if (result.status === "ok" || result.status === "stopped") {
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
    const preview = i === this.run.next ? STEP_DEFS[step.type].preview : undefined;
    const target = preview ? resolveStep(step, this.run.vars, resolveOptions(this.app, this.steps))[preview.key] : "";
    sub.createSpan({ cls: "quick-actions-rail-value", text: preview ? `${preview.verb} ${target}` : "Not run" });
  }

  // ---- Pane ----

  private select(i: number): void {
    this.setSelected(i);
    this.paneOpen = true;
    if (this.view === "run" && !this.resultFor(this.selected)) this.view = "edit";
    this.refreshAll();
  }

  // Every change of selection goes through here, which keeps it in range and moves it from an
  // Else if, Else or end of a block to the block's If, since only the If has a pane.
  private setSelected(i: number): void {
    const k = Math.max(0, Math.min(i, this.steps.length - 1));
    const step = this.steps[k];
    this.selected = step && isMarker(step) ? (blockOfMarker(this.steps, k)?.start ?? k) : k;
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
    const i = this.selected;
    const step = this.steps[i];
    const def = STEP_DEFS[step.type];
    this.paneInputs = availableInputs(this.steps, i);

    const head = pane.createDiv("quick-actions-pane-head");
    // Shown only on a phone, by CSS.
    iconButton(
      head,
      "arrow-left",
      "Back to steps",
      () => {
        this.paneOpen = false;
        this.modalEl.removeClass("is-pane-open");
      },
      "quick-actions-back",
    );
    head.createSpan({ cls: "quick-actions-num", text: String(stepNumbers(this.steps)[i]) });
    if (step.type === "if") {
      head.createSpan({ cls: "quick-actions-step-kind", text: def.verb });
    } else {
      const select = head.createEl("select", { cls: "dropdown" });
      for (const type of CONVERTIBLE_TYPES) select.createEl("option", { text: STEP_DEFS[type].verb, value: type });
      select.value = step.type;
      select.addEventListener("change", () => this.changeType(i, select.value as StepType));
    }
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
      this.refreshRailRow(i);
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
    iconButton(head, "ellipsis", "More", (evt) => this.stepMenu(evt.currentTarget as HTMLElement, i));

    if (this.view === "run" && result) {
      this.renderRunView(pane, step, i, result);
      return;
    }
    if (step.type === "if") {
      this.renderIfPane(pane, i);
      return;
    }

    const card = pane.createDiv("quick-actions-card");
    const inBand = card.createDiv();
    this.renderInBand(inBand, i);
    const body = card.createDiv("quick-actions-card-body");
    const blocked = blockedReason(step, this.env);
    if (blocked) new Setting(body).setName("This step can't run").setDesc(blocked).settingEl.addClass("is-warning");
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

  // The If block's own settings: one table row per branch, each with its tests, then what the
  // branches hand down. Its steps are edited by selecting them in the rail.
  private renderIfPane(pane: HTMLElement, i: number): void {
    const block = blocksOf(this.steps).get(i);
    if (!block) return;
    const card = pane.createDiv("quick-actions-card");
    const inBand = card.createDiv();
    this.renderInBand(inBand, i);
    const body = card.createDiv("quick-actions-card-body");
    body.createDiv({ cls: "quick-actions-hint quick-actions-branches-hint", text: "Tried top to bottom. The first branch whose tests pass runs, and the others are skipped." });
    const table = body.createDiv("quick-actions-branches");
    block.branches.forEach((m, k) => {
      const marker = this.steps[m];
      const count = stepCount(this.steps.slice(m + 1, branchEnd(block, k)));
      const row = table.createDiv("quick-actions-branch");
      const top = row.createDiv("quick-actions-branch-top");
      top.createSpan({ cls: "quick-actions-branch-kw", text: STEP_DEFS[marker.type].verb });
      if (marker.type === "if" || marker.type === "else_if") {
        if (marker.tests.length > 1) {
          const match = top.createSpan("quick-actions-branch-match");
          const select = match.createEl("select", { cls: "dropdown" });
          select.createEl("option", { text: "All tests pass", value: "all" });
          select.createEl("option", { text: "Any test passes", value: "any" });
          select.value = marker.match;
          select.addEventListener("change", () => {
            marker.match = select.value === "any" ? "any" : "all";
            this.renderRail();
          });
        }
      } else {
        top.createSpan({ cls: "quick-actions-hint", text: "Runs when no branch above does" });
      }
      top.createSpan("quick-actions-spacer");
      top.createSpan({ cls: "quick-actions-hint", text: plural(count, "step", "steps") });
      if (k > 0) iconButton(top, "x", "Remove this branch. Its steps move below the block.", () => this.removeBranchAt(m));
      if (marker.type === "if" || marker.type === "else_if") {
        marker.tests.forEach((_, n) => this.renderTest(row, marker, m, n, i, inBand));
        textButton(row.createDiv("quick-actions-branch-add"), "plus", "Add test", () => {
          marker.tests.push(newTest());
          this.renderRail();
          this.renderPane();
        });
      }
    });
    const buttons = body.createDiv("quick-actions-branch-buttons");
    textButton(buttons, "plus", "Else if", () => this.addBranch(block, "else_if"));
    const elseButton = textButton(buttons, "plus", "Else", () => this.addBranch(block, "else"));
    if (block.branches.some((m) => this.steps[m].type === "else")) {
      elseButton.disabled = true;
      elseButton.setAttr("aria-label", "This block already has an Else");
    }
    const band = card.createDiv("quick-actions-band is-out");
    band.createSpan({ cls: "quick-actions-band-lead", text: "Out" });
    const set = scopeBefore(this.steps, block.end + 1).filter((x) => x.from > block.start && x.from < block.end);
    for (const x of set) {
      const pill = renderPill(band, x.name, x.type, { cls: x.maybe ? "is-maybe" : undefined });
      if (x.maybe) pill.setAttr("aria-label", "It can be empty after the block");
    }
    const hint = set.length === 0 ? "nothing · no step in its branches produces a value" : set.some((x) => x.maybe) ? "dashed values can be empty after the block" : "always set after the block";
    band.createSpan({ cls: "quick-actions-hint", text: hint });
  }

  // One test of a branch: the value, how it is tested, and what it is compared with. `m` is the
  // index of the branch's If or Else if, whose rail row shows its first test.
  private renderTest(parent: HTMLElement, marker: IfStep | ElseIfStep, m: number, n: number, i: number, inBand: HTMLElement): void {
    const test = marker.tests[n];
    const line = parent.createDiv("quick-actions-test");
    const field = (value: string, placeholder: string, write: (v: string) => void) =>
      this.pillField(line, line, { value, multiline: false, placeholder }, (v) => {
        write(v);
        this.refreshInBand(inBand, i);
        this.refreshRailRow(m);
      });
    field(test.value, "Type {{ for a value", (v) => (test.value = v));
    const op = line.createEl("select", { cls: "dropdown" });
    for (const o of TEST_OPS) op.createEl("option", { text: o.label, value: o.value });
    op.value = test.op;
    op.addEventListener("change", () => {
      test.op = op.value as TestOp;
      this.renderRail();
      this.renderPane();
    });
    if (TEST_OPS.find((o) => o.value === test.op)?.needsText) field(test.text, test.op === "matches" ? "^https://" : "text", (v) => (test.text = v));
    if (marker.tests.length > 1) {
      iconButton(line, "x", "Remove this test", () => {
        marker.tests.splice(n, 1);
        this.renderRail();
        this.renderPane();
      });
    }
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
    const used = usedInputs(this.steps[i]);
    this.inBandUsed = used.join("|");
    const numbers = stepNumbers(this.steps);
    renderInBand(
      container,
      this.paneInputs,
      new Set(used),
      (input) => describeInput(input, this.steps, this.models, numbers),
      (name) => this.tracker.insert(name),
      i === 0 ? "first step, nothing from above yet" : undefined,
    );
  }

  // A field edit changes only which values the step uses, so the band is redrawn when those change.
  private refreshInBand(container: HTMLElement, i: number): void {
    if (usedInputs(this.steps[i]).join("|") !== this.inBandUsed) this.renderInBand(container, i);
  }

  private renderField(body: HTMLElement, step: Step, f: FieldDef, i: number, inBand: HTMLElement): void {
    const record = step as unknown as Record<string, unknown>;
    const setting = new Setting(body).setName(f.label);
    // A control its model can't use is off, and says why in place of its description.
    const reason = f.unavailable?.(step, this.models);
    const desc = reason ?? f.desc;
    if (desc) setting.setDesc(desc);
    const edited = () => this.refreshInBand(inBand, i);
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
            .onChange((v) => this.changeStep(i, step, () => (record[f.key] = v))),
        );
        return;
      case "dropdown":
        setting.addDropdown((d) => {
          for (const o of f.options ?? []) d.addOption(o.value, o.label);
          d.setDisabled(reason !== undefined)
            .setValue(String(record[f.key] ?? ""))
            .onChange((v) => this.changeStep(i, step, () => (record[f.key] = v)));
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
        this.pillField(setting.controlEl, setting.nameEl, { value: String(record[f.key] ?? ""), multiline, mono: f.mono, placeholder: f.placeholder }, (v) => {
          record[f.key] = v;
          edited();
        });
        return;
      }
    }
  }

  // A templated field of the selected step: its pills, the {{ picker, and a place in the In band's
  // insert target.
  private pillField(
    parent: HTMLElement,
    toolsParent: HTMLElement,
    look: { value: string; multiline: boolean; mono?: boolean; placeholder?: string },
    onChange: (value: string) => void,
  ): void {
    const field = createPillField(parent, {
      ...look,
      toolsParent,
      resolve: (name) => {
        const input = this.paneInputs.find((a) => a.name === name);
        return input ? { type: input.type, maybe: input.maybe } : null;
      },
      onChange,
      onFocus: () => (this.tracker.current = field),
    });
    attachVarPicker(this.app, field, () => this.pickerItems(this.selected));
    this.tracker.register(field);
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
      d.setValue(step.model).onChange((v) =>
        this.changeStep(i, step, () => {
          step.model = v;
          Object.assign(step, withoutUnavailable(step, this.models));
        }),
      );
    });
  }

  // Every change to step i other than typed text goes through here, since it can add or remove
  // outputs or change which fields show. An added output gets a name nothing else produces, while
  // the names the step already had stay as they are. A removed one that later steps use raises a
  // notice. Then the rail and the pane are redrawn.
  private changeStep(i: number, step: Step, change: () => void): void {
    const before = outputsOf(step).map((o) => o.name);
    change();
    if (outputsOf(step).length > before.length) freshOutputs(step, producedNames(this.steps.filter((s) => s !== step)).filter((n) => !before.includes(n)));
    const after = outputsOf(step).map((o) => o.name);
    const lost = before.filter((name) => !after.includes(name) && consumersOf(this.steps, i, name).length > 0);
    if (lost.length) new Notice(lostSource(lost));
    this.renderRail();
    this.renderPane();
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
        .onChange((v) =>
          this.changeStep(i, step, () => {
            if (v === "several") {
              step.outputs = [{ name: step.variable, desc: "", choices: [] }];
            } else {
              step.variable = step.outputs.find((o) => o.name === step.variable) ? step.variable : (step.outputs[0]?.name ?? step.variable);
              step.outputs = [];
            }
          }),
        ),
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
        iconButton(row, "x", "Remove", () => this.changeStep(i, step, () => step.outputs.splice(k, 1)));
      }
    });
    textButton(list.createDiv(), "plus", "Add value", () => this.changeStep(i, step, () => step.outputs.push({ name: "value", desc: "", choices: [] })));
  }

  // Everything the picker can offer at step i: available inputs, then later outputs greyed out.
  private pickerItems(i: number): VarItem[] {
    const items: VarItem[] = [];
    const vars = this.run ? this.varsBefore(i) : {};
    const numbers = stepNumbers(this.steps);
    const available = new Set(this.paneInputs.map((a) => a.name));
    for (const input of this.paneInputs) {
      if (input.from < 0) continue;
      items.push({
        name: input.name,
        type: input.type,
        source: describeInput(input, this.steps, this.models, numbers),
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
          source: `Step ${numbers[j]} · ${stepTitle(this.steps[j], this.models)}`,
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
    const marked = (template: string, cls = "", mode: ResolveMode = "plain", values = vars) => {
      const box = pane.createDiv(`quick-actions-result ${cls}`.trim());
      for (const seg of resolveSegments(template, values, opts, mode)) {
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
    } else if (result.note && step.type !== "quick_task" && step.type !== "open_file") {
      muted(result.note);
    }

    const isLast = i === this.lastRunIndex();
    const nextIndex = isLast && this.run ? this.run.next : i + 1;
    const next = this.steps[nextIndex];
    const nextPreview = next ? STEP_DEFS[next.type].preview : undefined;
    const nextField = next && nextPreview ? templatedFields(next).find((f) => f.key === nextPreview.key) : undefined;
    if (nextPreview && nextField) {
      label("Next step");
      marked(nextField.value, "is-muted", nextField.mode, this.varsBefore(nextIndex)).prepend(createSpan({ text: `${nextPreview.verb} ` }));
    }

    const actions = pane.createDiv("quick-actions-run-actions");
    if (isLast && next && this.run?.status === "ok") {
      const btn = textButton(actions, "play", `Run step ${stepNumbers(this.steps)[nextIndex]} too`, () => void this.runTo(nextIndex + 1, nextIndex));
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
  // When a structural change happened meanwhile, the results are dropped.
  private async runTo(end: number, from = 0): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = this.runGen;
    this.renderHead();
    const action = JSON.parse(JSON.stringify(this.draft)) as Action;
    const progress = new RunProgress(`Test run of ${action.name || "this action"}`, stepCount(action.steps), this.models);
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
        // Steps marked not taken stay marked, since the branch their block took is already decided.
        steps: [...this.run.steps.filter((r) => r.index < from || r.status === "skipped"), ...result.steps],
        vars: result.vars,
        status: result.status,
        ms: this.run.ms + result.ms,
        next: result.next,
      };
    } else {
      this.run = result;
    }
    const last = result.steps[result.steps.length - 1];
    if (last?.error) new Notice(`Step ${stepNumbers(this.steps)[last.index]} failed: ${last.error}`);
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

  // A new step goes just after the selected one, which with an If selected is the start of its
  // first branch, so building a branch needs no dragging. An If arrives with its end.
  private addStep(type: StepType): void {
    const at = this.steps.length === 0 ? 0 : this.selected + 1;
    const added = type === "if" ? [makeStep("if"), makeStep("end_if")] : [freshOutputs(makeStep(type), producedNames(this.steps))];
    this.steps.splice(at, 0, ...added);
    this.clearRun();
    this.select(at);
  }

  private wrapInIf(i: number): void {
    this.steps.splice(i + 1, 0, makeStep("end_if"));
    this.steps.splice(i, 0, makeStep("if"));
    this.clearRun();
    this.select(i);
  }

  private unwrap(i: number): void {
    unwrapBlock(this.steps, i);
    this.clearRun();
    this.select(Math.min(i, this.steps.length - 1));
  }

  // A new Else if goes before the Else, and an Else at the end.
  private addBranch(block: Block, type: "else_if" | "else"): void {
    const elseAt = block.branches.find((m) => this.steps[m].type === "else");
    this.steps.splice(type === "else_if" && elseAt !== undefined ? elseAt : block.end, 0, makeStep(type));
    this.clearRun();
    this.refreshAll();
  }

  private removeBranchAt(marker: number): void {
    const count = stepCount(removeBranch(this.steps, marker));
    if (count > 0) new Notice(`The branch's ${plural(count, "step", "steps")} moved below the block.`);
    this.clearRun();
    this.refreshAll();
  }

  // Besides up and down: into the end of each branch the step isn't in, and out of its block.
  private moveTargets(i: number): { title: string; to: number }[] {
    const targets: { title: string; to: number }[] = [];
    const place = placeOf(this.steps, i);
    for (const b of blocksOf(this.steps).values()) {
      b.branches.forEach((m, k) => {
        if (place?.block.start === b.start && place.branch === k) return;
        targets.push({ title: `Move into ${stepTitle(this.steps[m], this.models)}`, to: moveTo(i, branchEnd(b, k)) });
      });
    }
    if (place) targets.push({ title: "Move out of the If block", to: moveTo(i, place.block.end + 1) });
    return targets;
  }

  private stepMenu(at: HTMLElement, i: number): void {
    const step = this.steps[i];
    const end = spanEnd(this.steps, i);
    const extra: MenuEntry[] = [{ title: step.type === "if" ? "Duplicate with its steps" : "Duplicate", icon: "copy", click: () => this.duplicateStep(i) }];
    if (step.type === "if") {
      extra.push({ title: "Remove If, keep its steps", icon: "ungroup", click: () => this.unwrap(i) });
    } else {
      extra.push({ title: "Put in an If", icon: "split", click: () => this.wrapInIf(i) });
      for (const t of this.moveTargets(i)) extra.push({ title: t.title, icon: "corner-down-right", section: "branches", click: () => this.moveStep(i, t.to) });
    }
    showRowMenu(at, {
      extra,
      index: i,
      count: this.steps.length - (end - i), // a block counts as one row, and Move down takes it past the step after its end
      onMove: (to) => this.moveStep(i, to > i ? end + 1 : to),
      onDelete: () => this.deleteStep(i),
    });
  }

  // The converted step keeps an output name it may share with the other steps that produce it.
  private changeType(i: number, type: StepType): void {
    this.steps[i] = convertStep(this.steps[i], type, takenNames(this.steps, i, type));
    this.clearRun();
    this.refreshAll();
  }

  // An If is duplicated with its whole block.
  private duplicateStep(i: number): void {
    const end = spanEnd(this.steps, i);
    this.steps.splice(end + 1, 0, ...copySteps(this.steps, i, end));
    this.clearRun();
    this.select(end + 1);
  }

  // Deleting an If deletes its whole block. "Remove If, keep its steps" keeps them.
  private deleteStep(i: number): void {
    const end = spanEnd(this.steps, i);
    const lost = new Set<string>();
    for (let j = i; j <= end; j++) {
      for (const o of outputsOf(this.steps[j])) if (consumersOf(this.steps, j, o.name).some((c) => c > end)) lost.add(o.name);
    }
    const number = stepNumbers(this.steps)[i];
    this.steps.splice(i, end - i + 1);
    if (lost.size) new Notice(`Step ${number} deleted. ${lostSource([...lost])}`);
    this.setSelected(i);
    this.paneOpen = false;
    this.clearRun();
    this.refreshAll();
  }

  // Moves a step, or an If with its whole block.
  private moveStep(from: number, to: number): void {
    const start = moveSteps(this.steps, from, to);
    if (start < 0) return;
    this.setSelected(start);
    this.clearRun();
    this.refreshAll();
  }
}
