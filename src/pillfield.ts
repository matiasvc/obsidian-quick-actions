import { Platform } from "obsidian";
import { OutputType } from "./types";
import { formatRef, parseRefs, splitChain } from "./variables";
import { isFilter } from "./text";
import { renderPill } from "./ui";
import { filterEntries, showMenu } from "./menus";

// A text field whose {{variables}} show as pills. The value is always a plain
// template string, and the DOM is text nodes and non-editable pill spans. A pill
// shows its filters after its name, and clicking it offers the filters.

export interface PillFieldOptions {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  resolve: (name: string) => { type: OutputType; maybe?: boolean } | null; // null = nothing produces it, maybe = an If block may leave it unset
  onFocus: () => void;
  toolsParent: HTMLElement; // mobile puts the { } button here, in the field's label row
}

export interface PillField {
  editorEl: HTMLElement; // where the caret lives
  toolsEl: HTMLElement; // the slot for the { } button
  insertPill(name: string): void;
  addFilterAtCaret(id: string): boolean; // to the reference just before the caret
  focus(): void;
  pickerOpen: () => boolean; // set by the variable picker
}

// A zero-width space after each pill gives the caret a place to sit. Reads strip it.
const ZWSP = String.fromCharCode(0x200b);
const ZWSP_RE = new RegExp(ZWSP, "g");
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), "g");
const FOLD_LINES = 6;

// The filter menu for one reference. `toggle` adds or removes a filter, `clear` removes them all.
function showFilterMenu(evt: MouseEvent, name: string, current: string[], toggle: (id: string) => void, clear: () => void): void {
  const entries = [{ title: `Filter ${name}`, label: true, section: "filters" }, ...filterEntries(toggle, current)];
  if (current.length > 0) entries.push({ title: "Remove filters", icon: "x", section: "clear", click: clear });
  showMenu(entries, evt);
}

export function createPillField(parent: HTMLElement, opts: PillFieldOptions): PillField {
  const el = parent.createDiv("quick-actions-field");
  if (opts.mono) el.addClass("is-mono");
  if (!opts.multiline) el.addClass("is-single");
  if (Platform.isMobile) return mobileField(el, opts);

  const editorEl = el.createDiv({ cls: "quick-actions-field-editor", attr: { contenteditable: "plaintext-only", spellcheck: "false" } });
  if (opts.placeholder) editorEl.setAttr("data-placeholder", opts.placeholder);
  const toolsEl = el.createDiv("quick-actions-field-tools");
  const doc = el.doc;
  let savedRange: Range | null = null;
  let lastValue = opts.value;

  const setFilters = (pill: HTMLElement, filters: string[]) => {
    pill.setAttr("data-filters", filters.join("|"));
    for (const chip of Array.from(pill.querySelectorAll(".quick-actions-pill-filter"))) chip.remove();
    for (const f of filters) pill.createSpan({ cls: isFilter(f) ? "quick-actions-pill-filter" : "quick-actions-pill-filter is-unknown", text: f });
  };

  const pillEl = (name: string, filters: string[] = []): HTMLElement => {
    const known = opts.resolve(name);
    const pill = renderPill(editorEl, name, known?.type ?? null, { inline: true, unknown: !known, cls: known?.maybe ? "is-maybe" : undefined });
    pill.setAttr("contenteditable", "false");
    pill.setAttr("data-pill", name);
    pill.setAttr("aria-label", known?.maybe ? "It can be empty after its If block. Click to add a filter." : "Click to add a filter, like slug or trim");
    setFilters(pill, filters);
    pill.remove();
    return pill;
  };

  // Template text to nodes: text nodes and pills, each pill followed by a caret anchor.
  const nodesFor = (template: string): Node[] => {
    const nodes: Node[] = [];
    let last = 0;
    for (const ref of parseRefs(template)) {
      if (ref.index > last) nodes.push(doc.createTextNode(template.slice(last, ref.index)));
      nodes.push(pillEl(ref.name, ref.filters));
      nodes.push(doc.createTextNode(ZWSP));
      last = ref.index + ref.length;
    }
    if (last < template.length) nodes.push(doc.createTextNode(template.slice(last)));
    return nodes;
  };

  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const pill = node.getAttr("data-pill");
    if (pill) return formatRef(pill, splitChain(node.getAttr("data-filters")));
    if (node.tagName === "BR") return "\n";
    const inner = Array.from(node.childNodes).map(serialize).join("");
    return node.tagName === "DIV" || node.tagName === "P" ? "\n" + inner : inner;
  };

  const getValue = (): string => {
    let text = Array.from(editorEl.childNodes).map(serialize).join("");
    text = text.replace(ZWSP_RE, "").replace(NBSP_RE, " ");
    if (!opts.multiline) text = text.replace(/\n/g, " ");
    return text;
  };

  const render = (value: string) => {
    editorEl.empty();
    for (const n of nodesFor(value)) editorEl.appendChild(n);
    lastValue = value;
  };

  const emitChange = (value = getValue()) => {
    if (value === lastValue) return;
    lastValue = value;
    opts.onChange(value);
  };

  const selectionRange = (): Range | null => {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return editorEl.contains(range.startContainer) ? range : null;
  };

  const saveCaret = () => {
    const range = selectionRange();
    if (range) savedRange = range.cloneRange();
  };

  const placeCaretAfter = (node: Node) => {
    const range = doc.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    savedRange = range.cloneRange();
  };

  // Inserts nodes at the caret (live, else saved, else the end) and puts the caret after them.
  const insertNodes = (nodes: Node[]) => {
    if (nodes.length === 0) return;
    let range = selectionRange() ?? savedRange;
    if (range && !editorEl.contains(range.startContainer)) range = null;
    if (!range) {
      range = doc.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }
    range.deleteContents();
    // Split a text node so pills never end up nested in one.
    let anchor = range.startContainer;
    let offset = range.startOffset;
    if (anchor.nodeType === Node.TEXT_NODE) {
      const text = anchor as Text;
      if (offset < text.length) text.splitText(offset);
      offset = Array.from(editorEl.childNodes).indexOf(text) + 1;
      anchor = editorEl;
    }
    if (anchor !== editorEl) {
      // A caret inside a pill should not happen. Append after the pill.
      const pill = anchor instanceof HTMLElement ? anchor.closest("[data-pill]") : null;
      offset = pill ? Array.from(editorEl.childNodes).indexOf(pill) + 1 : editorEl.childNodes.length;
      anchor = editorEl;
    }
    const before = editorEl.childNodes[offset] ?? null;
    for (const n of nodes) editorEl.insertBefore(n, before);
    placeCaretAfter(nodes[nodes.length - 1]);
    editorEl.focus();
    emitChange();
  };

  // A pill directly before (dir -1) or after (dir 1) a collapsed caret, skipping zero-width anchors.
  const adjacentPill = (dir: -1 | 1): HTMLElement | null => {
    const range = selectionRange() ?? savedRange;
    if (!range || !range.collapsed || !editorEl.contains(range.startContainer)) return null;
    const node: Node = range.startContainer;
    let sibling: Node | null;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const rest = dir < 0 ? text.slice(0, range.startOffset) : text.slice(range.startOffset);
      if (rest.replace(ZWSP_RE, "") !== "") return null;
      sibling = dir < 0 ? node.previousSibling : node.nextSibling;
    } else if (node === editorEl) {
      sibling = dir < 0 ? (editorEl.childNodes[range.startOffset - 1] ?? null) : (editorEl.childNodes[range.startOffset] ?? null);
    } else {
      return null;
    }
    while (sibling && sibling.nodeType === Node.TEXT_NODE && (sibling.textContent ?? "").replace(ZWSP_RE, "") === "") {
      sibling = dir < 0 ? sibling.previousSibling : sibling.nextSibling;
    }
    return sibling instanceof HTMLElement && sibling.hasAttribute("data-pill") ? sibling : null;
  };

  const toggleFilter = (pill: HTMLElement, id: string) => {
    const current = splitChain(pill.getAttr("data-filters"));
    setFilters(pill, current.includes(id) ? current.filter((f) => f !== id) : [...current, id]);
    emitChange();
  };

  // Turns a completed {{name}} or {{name|filter}} typed by hand into a pill.
  const pillifyTyped = () => {
    for (const node of Array.from(editorEl.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent ?? "";
      if (parseRefs(text).length === 0) continue;
      const nodes = nodesFor(text);
      const last = nodes[nodes.length - 1];
      for (const n of nodes) editorEl.insertBefore(n, node);
      node.remove();
      placeCaretAfter(last);
    }
  };

  // A long value shows its first lines until the field gets focus or "Show all" is clicked.
  let moreEl: HTMLElement | null = null;
  const unfold = () => {
    el.removeClass("is-folded");
    moreEl?.remove();
    moreEl = null;
  };
  const lineCount = opts.value.split("\n").length;
  if (opts.multiline && lineCount > FOLD_LINES) {
    el.addClass("is-folded");
    moreEl = el.createDiv({ cls: "quick-actions-field-more", text: `Show all ${lineCount} lines` });
    moreEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    moreEl.addEventListener("click", unfold);
  }

  editorEl.addEventListener("click", (evt) => {
    const pill = evt.target instanceof HTMLElement ? evt.target.closest<HTMLElement>("[data-pill]") : null;
    if (!pill || !editorEl.contains(pill)) return;
    evt.preventDefault();
    const name = pill.getAttr("data-pill") ?? "";
    showFilterMenu(evt, name, splitChain(pill.getAttr("data-filters")), (id) => toggleFilter(pill, id), () => {
      setFilters(pill, []);
      emitChange();
    });
  });
  editorEl.addEventListener("input", (evt) => {
    if (!(evt instanceof InputEvent)) return; // synthetic events come from the picker
    if (evt.isComposing) return;
    pillifyTyped();
    const value = getValue();
    if (value === "" && editorEl.childNodes.length > 0) editorEl.empty(); // restore the placeholder
    saveCaret();
    emitChange(value);
  });
  editorEl.addEventListener("beforeinput", (evt) => {
    if (evt.inputType === "insertFromPaste" || evt.inputType === "insertFromDrop") {
      evt.preventDefault();
      const text = evt.dataTransfer?.getData("text/plain") ?? "";
      insertNodes(nodesFor(opts.multiline ? text : text.replace(/\n/g, " ")));
      return;
    }
    if (evt.inputType === "deleteContentBackward" || evt.inputType === "deleteContentForward") {
      const pill = adjacentPill(evt.inputType === "deleteContentBackward" ? -1 : 1);
      if (!pill) return;
      evt.preventDefault();
      const anchor = pill.previousSibling;
      pill.remove();
      if (anchor) placeCaretAfter(anchor);
      emitChange();
    }
  });
  editorEl.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter") return;
    if (field.pickerOpen()) {
      evt.preventDefault(); // the picker's own keymap selects the item
      return;
    }
    if (evt.isComposing) return;
    evt.preventDefault();
    if (opts.multiline && !evt.metaKey && !evt.ctrlKey) insertNodes([doc.createTextNode("\n")]);
  });
  editorEl.addEventListener("keyup", saveCaret);
  editorEl.addEventListener("mouseup", saveCaret);
  editorEl.addEventListener("focus", () => {
    el.addClass("is-focus");
    unfold();
    opts.onFocus();
  });
  editorEl.addEventListener("blur", () => {
    saveCaret();
    el.removeClass("is-focus");
  });

  render(opts.value);

  const field: PillField = {
    editorEl,
    toolsEl,
    insertPill: (name) => insertNodes([pillEl(name), doc.createTextNode(ZWSP)]),
    addFilterAtCaret: (id) => {
      const pill = adjacentPill(-1);
      if (!pill) return false;
      if (!splitChain(pill.getAttr("data-filters")).includes(id)) toggleFilter(pill, id);
      return true;
    },
    focus: () => editorEl.focus(),
    pickerOpen: () => false,
  };
  return field;
}

// Mobile keeps a plain text field showing raw {{name}}. The In band still inserts, and the { } menu
// adds filters to the reference before the caret.
function mobileField(el: HTMLElement, opts: PillFieldOptions): PillField {
  const editorEl = opts.multiline
    ? el.createEl("textarea", { cls: "quick-actions-field-editor", attr: { rows: 10 } })
    : el.createEl("input", { cls: "quick-actions-field-editor", attr: { type: "text" } });
  if (opts.placeholder) editorEl.placeholder = opts.placeholder;
  editorEl.value = opts.value;
  const toolsEl = opts.toolsParent.createDiv("quick-actions-field-tools is-in-label");
  editorEl.addEventListener("input", () => opts.onChange(editorEl.value));
  editorEl.addEventListener("focus", () => {
    el.addClass("is-focus");
    opts.onFocus();
  });
  editorEl.addEventListener("blur", () => el.removeClass("is-focus"));
  return {
    editorEl,
    toolsEl,
    insertPill: (name) => {
      const start = editorEl.selectionStart ?? editorEl.value.length;
      const end = editorEl.selectionEnd ?? start;
      editorEl.setRangeText(formatRef(name), start, end, "end");
      editorEl.focus();
      opts.onChange(editorEl.value);
    },
    addFilterAtCaret: (id) => {
      const caret = editorEl.selectionStart ?? editorEl.value.length;
      const before = editorEl.value.slice(0, caret);
      const ref = parseRefs(before).pop();
      if (!ref || ref.index + ref.length !== before.length) return false;
      if (!ref.filters.includes(id)) {
        editorEl.setRangeText(`|${id}`, caret - 2, caret - 2, "end");
        editorEl.setSelectionRange(caret + id.length + 1, caret + id.length + 1);
        opts.onChange(editorEl.value);
      }
      editorEl.focus();
      return true;
    },
    focus: () => editorEl.focus(),
    pickerOpen: () => false,
  };
}
