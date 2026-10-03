import { AbstractInputSuggest, App, Notice, Platform } from "obsidian";
import { OutputType } from "./types";
import { PillField } from "./pillfield";
import { renderPill } from "./ui";
import { FILTERS } from "./text";
import { MenuEntry, filterEntries, showMenu } from "./menus";

export interface VarItem {
  name: string;
  type: OutputType;
  source: string; // "Step 1 · Ask me · text", "Today"
  sample?: string; // a captured value, or an example
  builtin?: boolean;
  unavailable?: string; // reason it cannot be used here
}

// A query no name contains, so it matches nothing.
const NO_QUERY = String.fromCharCode(0);

// The last row of the full list, so filters are found without reading the docs.
const TIP: VarItem = { name: "", type: "text", source: "" };

// Opens when the user types "{{" in a pill field, or from the { } button.
export class VarPicker extends AbstractInputSuggest<VarItem> {
  private field: PillField;
  private getItems: () => VarItem[];
  private forceAll = false;
  isOpen = false;

  constructor(app: App, field: PillField, getItems: () => VarItem[]) {
    super(app, field.editorEl as HTMLDivElement);
    this.field = field;
    this.getItems = getItems;
    this.limit = 50;
    field.pickerOpen = () => this.isOpen;
  }

  // The word typed after "{{" before the caret, or a sentinel that yields nothing.
  getValue(): string {
    if (this.forceAll) return "";
    const typed = this.typedQuery();
    return typed === null ? NO_QUERY : typed.query;
  }

  setValue(): void {
    // Never flatten the pills. selectSuggestion inserts the pick.
  }

  private typedQuery(): { node: Text; start: number; query: string } | null {
    const sel = this.field.editorEl.doc.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !this.field.editorEl.contains(node)) return null;
    const before = (node.textContent ?? "").slice(0, range.startOffset);
    const m = before.match(/\{\{(\w*)$/);
    if (!m) return null;
    return { node: node as Text, start: before.length - m[0].length, query: m[1] };
  }

  getSuggestions(query: string): VarItem[] {
    if (query === NO_QUERY) return [];
    const lower = query.toLowerCase();
    const items = this.getItems().filter((i) => i.name.toLowerCase().startsWith(lower));
    return query === "" ? [...items, TIP] : items;
  }

  renderSuggestion(item: VarItem, el: HTMLElement): void {
    el.addClass("quick-actions-picker-item");
    if (item === TIP) {
      el.addClass("quick-actions-picker-tip");
      el.setText(`Click a value in the field to filter it: ${FILTERS.map((f) => f.id).join(", ")}`);
      return;
    }
    if (item.unavailable) el.addClass("is-dim");
    renderPill(el, item.name, item.type, { builtin: item.builtin });
    const text = el.createDiv("quick-actions-picker-text");
    text.createSpan({ cls: "quick-actions-picker-src", text: item.unavailable ? `${item.source} · ${item.unavailable}` : item.source });
    if (item.sample) text.createSpan({ cls: "quick-actions-picker-sample", text: item.sample });
  }

  selectSuggestion(item: VarItem): void {
    this.close();
    if (item.unavailable || item === TIP) return;
    const typed = this.typedQuery();
    if (typed) {
      typed.node.deleteData(typed.start, typed.query.length + 2);
      const range = this.field.editorEl.doc.createRange();
      range.setStart(typed.node, typed.start);
      range.collapse(true);
      const sel = this.field.editorEl.doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    this.field.insertPill(item.name);
  }

  open(): void {
    super.open();
    this.isOpen = true;
  }

  close(): void {
    super.close();
    this.isOpen = false;
  }

  // Shows every item regardless of what is typed.
  openAll(): void {
    this.forceAll = true;
    this.field.focus();
    // The base class recomputes suggestions on the element's input event.
    this.field.editorEl.dispatchEvent(new Event("input"));
    this.forceAll = false;
  }
}

// Adds the { } button to a field and wires the picker. On mobile the button opens a menu instead,
// with the values and then the filters for the value just before the cursor.
export function attachVarPicker(app: App, field: PillField, getItems: () => VarItem[]): void {
  const button = field.toolsEl.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Insert a value or a filter" } });
  button.createSpan({ cls: "quick-actions-braces", text: "{ }" });
  button.addEventListener("mousedown", (evt) => evt.preventDefault()); // keep the field's focus and caret
  if (Platform.isMobile) {
    button.addEventListener("click", (evt) => {
      const entries: MenuEntry[] = [{ title: "Insert a value", label: true, section: "values" }];
      for (const item of getItems()) {
        entries.push({ title: item.name, section: "values", disabled: !!item.unavailable, click: () => field.insertPill(item.name) });
      }
      entries.push({ title: "Filter the value before the cursor", label: true, section: "filters" });
      entries.push(
        ...filterEntries((id) => {
          if (!field.addFilterAtCaret(id)) new Notice("Put the cursor right after a {{value}} first");
        }),
      );
      showMenu(entries, evt);
    });
    return;
  }
  const picker = new VarPicker(app, field, getItems);
  button.addEventListener("click", () => {
    if (picker.isOpen) picker.close();
    else picker.openAll();
  });
}
