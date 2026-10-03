import { App, Notice, moment, setIcon } from "obsidian";
import { Action, ModelConfig, OutputType, Step } from "./types";
import { StepEnv, blockedReason, stepTitle } from "./steps";
import { BUILTINS, InputInfo } from "./variables";
import { blocksOf } from "./flow";
import type { PillField } from "./pillfield";

// Small DOM helpers shared by the settings tab and the editors.

export function iconEl(parent: HTMLElement, name: string, cls?: string): HTMLElement {
  const el = parent.createSpan({ cls: cls ? `quick-actions-icon ${cls}` : "quick-actions-icon" });
  setIcon(el, name);
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
  inline?: boolean; // lives inside a pill field
  cls?: string;
}

export function renderPill(parent: HTMLElement, name: string, type: OutputType | null, look: PillLook = {}): HTMLElement {
  const el = parent.createSpan({ cls: "quick-actions-pill", text: name });
  if (type === "file") el.addClass("is-file");
  if (look.off) el.addClass("is-off");
  if (look.builtin) el.addClass("is-builtin");
  if (look.unknown) el.addClass("is-unknown");
  if (look.inline) el.addClass("is-inline");
  if (look.cls) el.addClass(look.cls);
  return el;
}

// `numbers` is stepNumbers(steps), computed once by callers that describe several inputs.
export function describeInput(input: InputInfo, steps: Step[], models: ModelConfig[], numbers: number[]): string {
  if (input.from < 0) return BUILTINS.find((b) => b.name === input.name)?.source ?? "Always available";
  const maybe = input.maybe ? " · can be empty after its If block" : "";
  return `Step ${numbers[input.from]} · ${stepTitle(steps[input.from], models)} · ${input.type}${maybe}`;
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
    if (input.maybe) pill.addClass("is-maybe");
    pill.setAttr("aria-label", `${describe(input)}. Click to insert.`);
    // Keep the field's focus and caret so the pill lands where the user was typing.
    pill.addEventListener("mousedown", (evt) => evt.preventDefault());
    pill.addEventListener("click", () => onPick(input.name));
  }
  if (hint) band.createSpan({ cls: "quick-actions-hint", text: hint });
  return band;
}

// Remembers which pill field was focused last so the In band can insert into it, or into the
// first field when none was.
export class FieldFocusTracker {
  private first: PillField | null = null;
  current: PillField | null = null;

  reset(): void {
    this.first = null;
    this.current = null;
  }

  register(field: PillField): void {
    this.first ??= field;
  }

  insert(name: string): void {
    (this.current ?? this.first)?.insertPill(name);
  }
}

// The steps on an action row as one line of titles. An If block collapses to its branch count,
// since its branches don't run in a line. A step that can't run, or a block holding one, is marked
// with the reason as its tooltip.
export function flowEl(parent: HTMLElement, steps: Step[], env: StepEnv): HTMLElement {
  const flow = parent.createDiv("quick-actions-flow");
  if (steps.length === 0) {
    flow.setText("No steps yet");
    return flow;
  }
  const blocks = blocksOf(steps);
  for (let i = 0; i < steps.length; i++) {
    if (i > 0) flow.createSpan({ cls: "quick-actions-flow-sep", text: "›" });
    const block = blocks.get(i);
    const span = block ? steps.slice(i, block.end + 1) : [steps[i]];
    const el = block
      ? flow.createSpan({ cls: "is-if", text: `If (${plural(block.branches.length, "branch", "branches")})` })
      : flow.createSpan({ cls: steps[i].type === "llm" ? "is-llm" : undefined, text: stepTitle(steps[i], env.models) });
    const blocked = span.map((s) => blockedReason(s, env)).find((r) => r);
    if (blocked) {
      el.addClass("is-error");
      el.setAttr("aria-label", blocked);
    }
    if (block) i = block.end;
  }
  return flow;
}

export const UNDO_NOTICE_MS = 10000;

export interface NoticeLink {
  text: string;
  click: () => void;
  keep?: boolean; // leave the notice up after the click
}

// A link in a notice. Its click never reaches the notice, which hides on any click, so the link
// decides with `keep` whether the notice stays.
export function noticeLink(notice: Notice, parent: HTMLElement, link: NoticeLink): HTMLElement {
  const el = parent.createEl("a", { text: link.text });
  el.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    if (!link.keep) notice.hide();
    link.click();
  });
  return el;
}

// A notice with an optional bold title, lines of text and a row of links. A duration of 0 keeps it
// up until it is clicked.
export function linkNotice(lines: string[], links: NoticeLink[], duration?: number, title?: string): Notice {
  const notice = new Notice("", duration);
  const el = notice.messageEl;
  el.addClass("quick-actions-notice");
  if (title) el.createEl("b", { text: title });
  for (const line of lines) el.createDiv({ text: line });
  if (links.length > 0) {
    const row = el.createDiv("quick-actions-notice-acts");
    for (const link of links) noticeLink(notice, row, link);
  }
  return notice;
}

// By id, which survives a rename. The handler still accepts the name's slug for older links.
export function actionUri(app: App, action: Action): string {
  return `obsidian://quick-actions?vault=${encodeURIComponent(app.vault.getName())}&run=${encodeURIComponent(action.id)}`;
}

export function copyUri(app: App, action: Action): void {
  void navigator.clipboard.writeText(actionUri(app, action));
  // eslint-disable-next-line obsidianmd/ui/sentence-case -- URI is an acronym
  new Notice("URI copied to clipboard");
}

// "used today", "used yesterday" or "used 4 Sep", for when an action last ran.
export function usedLabel(at: number): string {
  const m = moment(at);
  if (m.isSame(moment(), "day")) return "used today";
  if (m.isSame(moment().subtract(1, "day"), "day")) return "used yesterday";
  return `used ${m.format("D MMM")}`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
