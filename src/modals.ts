import { App, FuzzyMatch, FuzzySuggestModal, Keymap, Modal, Platform, TFile, getIconIds, moment, renderResults, setIcon } from "obsidian";
import { Action, FileKind } from "./types";
import { actionUses, loadDraft, recentFiles, saveDraft } from "./recent";
import { mediaTypeOf } from "./providers";
import { usedLabel } from "./ui";

export interface PromptOptions {
  title: string; // the action's name
  label: string;
  multiline: boolean;
  initial: string;
  draftKey: string; // where unsent text is kept, per action and step
}

// Unsent text survives Esc and the close button and comes back the next time the same prompt
// opens. Cancel throws it away.
export class PromptModal extends Modal {
  private input: HTMLInputElement | HTMLTextAreaElement;
  private submitted = false;
  private discarded = false;

  constructor(app: App, private opts: PromptOptions, private resolve: (value: string | null) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    // mod-form lifts Obsidian's button row above a phone's keyboard.
    this.modalEl.addClass("quick-actions-prompt", "mod-form");
    this.setTitle(opts.title);
    const id = `quick-actions-prompt-${Date.now()}`;
    if (opts.label) contentEl.createEl("label", { cls: "quick-actions-prompt-label", text: opts.label.replace(/:\s*$/, ""), attr: { for: id } });
    this.input = opts.multiline
      ? contentEl.createEl("textarea", { cls: "quick-actions-prompt-textarea", attr: { id, rows: 6 } })
      : contentEl.createEl("input", { cls: "quick-actions-prompt-input", attr: { id, type: "text" } });
    const draft = loadDraft(this.app, opts.draftKey);
    this.input.value = draft?.text ?? opts.initial;

    // Obsidian's button row, which stacks the buttons on a phone. A mod-secondary item sits at the
    // far left on a desktop and below the buttons on a phone.
    const footer = contentEl.createDiv("modal-button-container");
    if (draft || !Platform.isMobile) {
      const hint = footer.createDiv("quick-actions-prompt-hint mod-secondary");
      if (draft) hint.createSpan({ text: `Restored from ${moment(draft.at).format("HH:mm")}` });
      if (!Platform.isMobile) {
        if (draft) hint.appendText(" · ");
        if (opts.multiline) {
          hint.createEl("kbd", { text: Platform.isMacOS ? "⌘" : "Ctrl" });
          hint.appendText(" ");
        }
        hint.createEl("kbd", { text: "Enter" });
        hint.appendText(" to save");
      }
    }
    footer.createEl("button", { text: "Cancel", cls: "mod-cancel" }).addEventListener("click", () => {
      this.discarded = true;
      this.close();
    });
    footer.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.submit());

    this.input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Enter" || evt.isComposing) return;
      if (opts.multiline && !Keymap.isModifier(evt, "Mod")) return;
      evt.preventDefault();
      this.submit();
    });
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  private submit(): void {
    this.submitted = true;
    this.close();
  }

  onClose(): void {
    const value = this.input.value;
    const keep = !this.submitted && !this.discarded && value.trim() !== "" && value !== this.opts.initial;
    saveDraft(this.app, this.opts.draftKey, keep ? value : "");
    this.contentEl.empty();
    this.resolve(this.submitted ? value : null);
  }
}

export function openPromptModal(app: App, opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => new PromptModal(app, opts, resolve).open());
}

// Resolves with the picked item, or null when closed without a pick. A pick closes the modal
// before it chooses, so selectSuggestion marks it first.
abstract class PickModal<T> extends FuzzySuggestModal<T> {
  private picked = false;

  constructor(app: App, private resolveWith: (value: T | null) => void) {
    super(app);
  }

  selectSuggestion(value: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.picked = true;
    super.selectSuggestion(value, evt);
  }

  onChooseItem(item: T): void {
    this.resolveWith(item);
  }

  onClose(): void {
    if (!this.picked) this.resolveWith(null);
  }
}

// Files you picked recently first, then the rest A to Z, each with its folder and last edit.
export class FilePickerModal extends PickModal<TFile> {
  private recent: Set<string>;

  constructor(app: App, private files: TFile[], label: string, recentKey: string, resolve: (value: TFile | null) => void) {
    super(app, resolve);
    this.setPlaceholder(label || "Pick a file");
    const recent = recentFiles(app, recentKey);
    this.recent = new Set(recent);
    const rank = (f: TFile) => {
      const i = recent.indexOf(f.path);
      return i === -1 ? recent.length : i;
    };
    this.files = [...files].sort((a, b) => rank(a) - rank(b) || a.basename.localeCompare(b.basename));
  }

  getItems(): TFile[] {
    return this.files;
  }

  // A note by its name, any other file with its extension, so scan.pdf and scan.png differ.
  getItemText(item: TFile): string {
    return item.extension === "md" ? item.basename : item.name;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = match.item;
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    renderResults(content.createDiv("suggestion-title"), this.getItemText(file), match.match);
    const folder = file.parent && !file.parent.isRoot() ? `${file.parent.path} · ` : "";
    content.createDiv({ cls: "suggestion-note", text: `${folder}edited ${moment(file.stat.mtime).fromNow()}` });
    if (this.recent.has(file.path)) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair quick-actions-flair", text: "Recent" });
  }
}

export class ChoiceModal extends PickModal<string> {
  constructor(app: App, label: string, private options: string[], resolve: (value: string | null) => void) {
    super(app, resolve);
    this.setPlaceholder(label);
  }

  getItems(): string[] {
    return this.options;
  }

  getItemText(item: string): string {
    return item;
  }
}

export function openChoiceModal(app: App, label: string, options: string[]): Promise<string | null> {
  return new Promise((resolve) => new ChoiceModal(app, label, options, resolve).open());
}

// Picks one of the files of `kind` in `folder` (a path prefix, "" for the whole vault). Null when
// cancelled, undefined when the folder has none.
export function openFilePickerModal(app: App, folder: string, label: string, recentKey: string, kind: FileKind): Promise<string | null | undefined> {
  const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
  const all = kind === "notes" ? app.vault.getMarkdownFiles() : app.vault.getFiles().filter((f) => kind === "any" || mediaTypeOf(f.extension) !== undefined);
  const files = all.filter((f) => f.path.startsWith(prefix));
  if (files.length === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => new FilePickerModal(app, files, label, recentKey, (file) => resolve(file ? file.path : null)).open());
}

// The launcher: every action, the most recently run first.
export class ActionPickerModal extends FuzzySuggestModal<Action> {
  private uses: Record<string, number>;

  constructor(app: App, private actions: Action[], private run: (action: Action) => void) {
    super(app);
    this.uses = actionUses(app);
    this.setPlaceholder("Run a quick action");
    this.actions = [...actions].sort((a, b) => (this.uses[b.id] ?? 0) - (this.uses[a.id] ?? 0));
  }

  getItems(): Action[] {
    return this.actions;
  }

  getItemText(item: Action): string {
    return item.name;
  }

  renderSuggestion(match: FuzzyMatch<Action>, el: HTMLElement): void {
    el.addClass("mod-complex", "quick-actions-launch-item");
    setIcon(el.createDiv("suggestion-icon"), match.item.icon);
    renderResults(el.createDiv("suggestion-content").createDiv("suggestion-title"), match.item.name, match.match);
    const used = this.uses[match.item.id];
    if (used) el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-hotkey", text: usedLabel(used) });
  }

  onChooseItem(item: Action): void {
    this.run(item);
  }
}

// Every icon Obsidian ships, searchable by name. Lucide icons go by their short name, which
// setIcon accepts too.
export class IconPickerModal extends FuzzySuggestModal<string> {
  private icons = getIconIds().map((id) => id.replace(/^lucide-/, ""));

  constructor(app: App, private choose: (icon: string) => void) {
    super(app);
    this.setPlaceholder("Search icons");
  }

  getItems(): string[] {
    return this.icons;
  }

  getItemText(item: string): string {
    return item;
  }

  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("mod-complex", "quick-actions-launch-item");
    setIcon(el.createDiv("suggestion-icon"), match.item);
    renderResults(el.createDiv("suggestion-content").createDiv("suggestion-title"), match.item, match.match);
  }

  onChooseItem(item: string): void {
    this.choose(item);
  }
}
