import { App, Notice, setIcon } from "obsidian";
import { Action, ModelConfig, OutputType, Step, toSlug } from "./types";
import { STEP_DEFS, stepTitle } from "./steps";
import { InputInfo } from "./variables";
import type { PillField } from "./pillfield";

// Small DOM helpers shared by the settings tab and the editors.

export function iconEl(parent: HTMLElement, name: string, cls?: string): HTMLElement {
  const el = parent.createSpan({ cls: cls ? `quick-actions-icon ${cls}` : "quick-actions-icon" });
  setIcon(el, name);
  return el;
}

// An icon followed by text.
export function labelEl(parent: HTMLElement, cls: string, icon: string, text: string): HTMLElement {
  const el = parent.createSpan({ cls });
  iconEl(el, icon);
  el.appendText(text);
  return el;
}

export function iconButton(parent: HTMLElement, icon: string, label: string, handler: (evt: MouseEvent) => void, cls?: string): HTMLElement {
  const el = parent.createDiv({ cls: cls ? `clickable-icon ${cls}` : "clickable-icon", attr: { "aria-label": label } });
  setIcon(el, icon);
  el.addEventListener("click", handler);
  return el;
}

// A button with a leading icon, the "Add step" / "Test run" look.
export function textButton(parent: HTMLElement, icon: string, text: string, handler: () => void, cta = false): HTMLButtonElement {
  const el = parent.createEl("button", { cls: cta ? "quick-actions-button mod-cta" : "quick-actions-button" });
  setIcon(el.createSpan(), icon);
  el.appendText(text);
  el.addEventListener("click", handler);
  return el;
}

export interface PillLook {
  off?: boolean; // available but not used here
  builtin?: boolean;
  unknown?: boolean; // referenced but nothing produces it
  mono?: boolean;
  inline?: boolean; // lives inside a pill field
  cls?: string;
}

export function renderPill(parent: HTMLElement, name: string, type: OutputType | null, look: PillLook = {}): HTMLElement {
  const el = parent.createSpan({ cls: "quick-actions-pill", text: name });
  if (type === "file") el.addClass("is-file");
  if (look.off) el.addClass("is-off");
  if (look.builtin) el.addClass("is-builtin");
  if (look.unknown) el.addClass("is-unknown");
  if (look.mono) el.addClass("is-mono");
  if (look.inline) el.addClass("is-inline");
  if (look.cls) el.addClass(look.cls);
  return el;
}

export function describeInput(input: InputInfo, steps: Step[], models: ModelConfig[]): string {
  if (input.from < 0) return "Always available";
  return `Step ${input.from + 1} · ${stepTitle(steps[input.from], models)} · ${input.type}`;
}

// The "In" band: every value this step could use, tinted when it does.
export function renderInBand(
  parent: HTMLElement,
  inputs: InputInfo[],
  used: Set<string>,
  describe: (input: InputInfo) => string,
  onPick: (name: string) => void,
  hint?: string,
): HTMLElement {
  const band = parent.createDiv("quick-actions-band is-in");
  band.createSpan({ cls: "quick-actions-band-lead", text: "In" });
  const fromSteps = inputs.filter((i) => i.from >= 0);
  const builtins = inputs.filter((i) => i.from < 0);
  for (const input of [...fromSteps, ...builtins]) {
    const pill = renderPill(band, input.name, input.type, { off: !used.has(input.name), cls: "is-pickable" });
    pill.setAttr("aria-label", `${describe(input)}. Click to insert.`);
    // Keep the field's focus and caret so the pill lands where the user was typing.
    pill.addEventListener("mousedown", (evt) => evt.preventDefault());
    pill.addEventListener("click", () => onPick(input.name));
  }
  if (hint) band.createSpan({ cls: "quick-actions-hint", text: hint });
  return band;
}

// Remembers which pill field was focused last so the In band can insert into it.
export class FieldFocusTracker {
  fields: PillField[] = [];
  current: PillField | null = null;

  reset(): void {
    this.fields = [];
    this.current = null;
  }

  register(field: PillField): void {
    this.fields.push(field);
  }

  insert(name: string): void {
    const target = this.current ?? this.fields[0];
    if (!target) return;
    target.insertPill(name);
  }
}

// The step chain shown on an action row: chips joined by chevrons.
export function chainEl(parent: HTMLElement, steps: Step[], models: ModelConfig[]): HTMLElement {
  const chain = parent.createDiv("quick-actions-chain");
  steps.forEach((step, i) => {
    if (i > 0) iconEl(chain, "chevron-right", "quick-actions-arrow");
    const chip = labelEl(chain, "quick-actions-chip", STEP_DEFS[step.type].icon, stepTitle(step, models));
    if (step.type === "llm") chip.addClass("is-llm");
  });
  if (steps.length === 0) chain.createSpan({ cls: "quick-actions-chip is-add", text: "No steps" });
  return chain;
}

export function emptyEl(parent: HTMLElement, title: string | null, text: string): { el: HTMLElement; row: HTMLElement } {
  const el = parent.createDiv(title ? "quick-actions-empty" : "quick-actions-empty is-compact");
  if (title) el.createDiv({ cls: "quick-actions-empty-title", text: title });
  el.createDiv({ cls: "quick-actions-empty-text", text });
  const row = el.createDiv("quick-actions-empty-row");
  return { el, row };
}

export function actionUri(app: App, action: Action): string {
  return `obsidian://quick-actions?vault=${encodeURIComponent(app.vault.getName())}&run=${encodeURIComponent(toSlug(action.name))}`;
}

export function copyUri(app: App, action: Action): void {
  void navigator.clipboard.writeText(actionUri(app, action));
  // eslint-disable-next-line obsidianmd/ui/sentence-case -- URI is an acronym
  new Notice("URI copied to clipboard");
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function truncate(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
