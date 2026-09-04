import { Menu } from "obsidian";
import { StepType } from "./types";
import { STEP_DEFS, STEP_GROUPS } from "./steps";

export interface MenuEntry {
  title: string;
  desc?: string; // second, muted line
  icon?: string;
  accent?: boolean; // tint the icon
  section?: string; // Obsidian separates consecutive sections
  label?: boolean;
  warning?: boolean;
  disabled?: boolean;
  click?: () => void;
}

// A two-line title: Obsidian has no description API, so the title is a fragment.
// `is-accent` on the wrapper lets CSS tint the sibling icon via :has().
export function entryFragment(entry: MenuEntry): DocumentFragment {
  const fragment = new DocumentFragment();
  const wrap = fragment.createDiv(entry.accent ? "quick-actions-menu-entry is-accent" : "quick-actions-menu-entry");
  wrap.createSpan({ text: entry.title });
  if (entry.desc) wrap.createDiv({ cls: "quick-actions-menu-desc", text: entry.desc });
  return fragment;
}

export function addEntries(menu: Menu, entries: MenuEntry[]): Menu {
  for (const e of entries) {
    menu.addItem((item) => {
      item.setTitle(e.desc || e.accent ? entryFragment(e) : e.title);
      if (e.icon) item.setIcon(e.icon);
      if (e.section) item.setSection(e.section);
      if (e.label) item.setIsLabel(true);
      if (e.warning) item.setWarning(true);
      if (e.disabled) item.setDisabled(true);
      if (e.click) item.onClick(e.click);
    });
  }
  return menu;
}

// Shows a menu below an element, or at the mouse when given an event.
export function showMenu(entries: MenuEntry[], at: MouseEvent | HTMLElement): Menu {
  const menu = addEntries(new Menu(), entries);
  if (at instanceof MouseEvent) {
    menu.showAtMouseEvent(at);
  } else {
    const rect = at.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }
  return menu;
}

// The list-row menu shared by actions, models and steps: custom entries, then move, then delete.
export function showRowMenu(
  at: MouseEvent | HTMLElement,
  opts: { extra: MenuEntry[]; index: number; count: number; onMove: (to: number) => void; onDelete: () => void },
): Menu {
  const entries: MenuEntry[] = [...opts.extra.map((e) => ({ ...e, section: e.section ?? "edit" }))];
  if (opts.index > 0) entries.push({ title: "Move up", icon: "arrow-up", section: "move", click: () => opts.onMove(opts.index - 1) });
  if (opts.index < opts.count - 1) entries.push({ title: "Move down", icon: "arrow-down", section: "move", click: () => opts.onMove(opts.index + 1) });
  entries.push({ title: "Delete", icon: "trash-2", section: "danger", warning: true, click: opts.onDelete });
  return showMenu(entries, at);
}

// The grouped step picker under "Add step".
export function showAddStepMenu(at: MouseEvent | HTMLElement, onPick: (type: StepType) => void): Menu {
  const entries: MenuEntry[] = [];
  for (const group of STEP_GROUPS) {
    entries.push({ title: group.label, label: true, section: group.id });
    for (const type of group.types) {
      const def = STEP_DEFS[type];
      entries.push({ title: def.verb, desc: def.description, icon: def.icon, section: group.id, accent: type === "llm", click: () => onPick(type) });
    }
  }
  return showMenu(entries, at);
}
