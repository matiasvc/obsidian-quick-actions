import { Platform } from "obsidian";
import { OutputType } from "./types";
import { VAR_RE } from "./variables";
import { renderPill } from "./ui";

// A text field whose {{variables}} show as pills. The value is always a plain
// template string; the DOM is text nodes and non-editable pill spans.

export interface PillFieldOptions {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  resolve: (name: string) => { type: OutputType } | null; // null = nothing produces it
  onFocus?: () => void;
}

export interface PillField {
  el: HTMLElement; // the bordered box
  editorEl: HTMLElement; // where the caret lives
  toolsEl: HTMLElement; // top-right slot for the { } button
  getValue(): string;
  setValue(value: string): void; // rebuilds; use only for external changes
  refresh(): void; // recomputes pill looks without touching the caret
  insertPill(name: string): void;
  focus(): void;
  isFocused(): boolean;
  pickerOpen: () => boolean; // set by the variable picker
}

// A zero-width space after each pill gives the caret a place to sit; stripped on read.
const ZWSP = String.fromCharCode(0x200b);
const ZWSP_RE = new RegExp(ZWSP, "g");
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), "g");

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

  const pillEl = (name: string): HTMLElement => {
    const known = opts.resolve(name);
    const pill = renderPill(editorEl, name, known?.type ?? null, { inline: true, unknown: !known });
    pill.setAttr("contenteditable", "false");
    pill.setAttr("data-pill", name);
    pill.remove();
    return pill;
  };

  // Template text to nodes: text nodes and pills, each pill followed by a caret anchor.
  const nodesFor = (template: string): Node[] => {
    const nodes: Node[] = [];
    let last = 0;
    for (const m of template.matchAll(VAR_RE)) {
      const start = m.index ?? 0;
      if (start > last) nodes.push(doc.createTextNode(template.slice(last, start)));
      nodes.push(pillEl(m[1]));
      nodes.push(doc.createTextNode(ZWSP));
      last = start + m[0].length;
    }
    if (last < template.length) nodes.push(doc.createTextNode(template.slice(last)));
    return nodes;
  };

  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const pill = node.getAttr("data-pill");
    if (pill) return `{{${pill}}}`;
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

  const emitChange = () => {
    const value = getValue();
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
      // The caret sits inside a pill (should not happen): append after it.
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
    const range = selectionRange();
    if (!range || !range.collapsed) return null;
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

  // Turns a completed {{name}} typed by hand into a pill.
  const pillifyTyped = () => {
    for (const node of Array.from(editorEl.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent ?? "";
      if (!/\{\{\w+\}\}/.test(text)) continue;
      const nodes = nodesFor(text);
      const last = nodes[nodes.length - 1];
      for (const n of nodes) editorEl.insertBefore(n, node);
      node.remove();
      placeCaretAfter(last);
    }
  };

  editorEl.addEventListener("input", (evt) => {
    if (!(evt instanceof InputEvent)) return; // synthetic events come from the picker
    if (evt.isComposing) return;
    pillifyTyped();
    if (getValue() === "" && editorEl.childNodes.length > 0) editorEl.empty(); // restore the placeholder
    saveCaret();
    emitChange();
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
    opts.onFocus?.();
  });
  editorEl.addEventListener("blur", () => {
    saveCaret();
    el.removeClass("is-focus");
  });

  render(opts.value);

  const field: PillField = {
    el,
    editorEl,
    toolsEl,
    getValue,
    setValue: render,
    refresh: () => {
      for (const pill of Array.from(editorEl.querySelectorAll<HTMLElement>("[data-pill]"))) {
        const known = opts.resolve(pill.getAttr("data-pill") ?? "");
        pill.toggleClass("is-unknown", !known);
        pill.toggleClass("is-file", known?.type === "file");
      }
    },
    insertPill: (name) => insertNodes([pillEl(name), doc.createTextNode(ZWSP)]),
    focus: () => editorEl.focus(),
    isFocused: () => doc.activeElement === editorEl,
    pickerOpen: () => false,
  };
  return field;
}

// Mobile keeps a plain textarea showing raw {{name}}; the In band still inserts.
function mobileField(el: HTMLElement, opts: PillFieldOptions): PillField {
  const editorEl = opts.multiline
    ? el.createEl("textarea", { cls: "quick-actions-field-editor", attr: { rows: 4 } })
    : el.createEl("input", { cls: "quick-actions-field-editor", attr: { type: "text" } });
  if (opts.placeholder) editorEl.placeholder = opts.placeholder;
  editorEl.value = opts.value;
  const toolsEl = el.createDiv("quick-actions-field-tools");
  editorEl.addEventListener("input", () => opts.onChange(editorEl.value));
  editorEl.addEventListener("focus", () => {
    el.addClass("is-focus");
    opts.onFocus?.();
  });
  editorEl.addEventListener("blur", () => el.removeClass("is-focus"));
  return {
    el,
    editorEl,
    toolsEl,
    getValue: () => editorEl.value,
    setValue: (v) => {
      editorEl.value = v;
    },
    refresh: () => {},
    insertPill: (name) => {
      const start = editorEl.selectionStart ?? editorEl.value.length;
      const end = editorEl.selectionEnd ?? start;
      editorEl.setRangeText(`{{${name}}}`, start, end, "end");
      editorEl.focus();
      opts.onChange(editorEl.value);
    },
    focus: () => editorEl.focus(),
    isFocused: () => el.doc.activeElement === editorEl,
    pickerOpen: () => false,
  };
}
