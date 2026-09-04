import { Platform } from "obsidian";

export interface DragReorderOptions {
  itemSelector: string;
  handleSelector?: string; // press must start here; the whole item when omitted
  onReorder: (from: number, to: number) => void; // `to` is the item's final index
}

// Native HTML5 drag between the direct matches of itemSelector inside container.
// Listeners are delegated so re-rendered rows keep working. Returns a disposer.
export function enableDragReorder(container: HTMLElement, opts: DragReorderOptions): () => void {
  if (Platform.isMobile) return () => {};

  let armed: HTMLElement | null = null;
  let from = -1;
  let overIndex = -1;
  let overBefore = false;

  const items = () => Array.from(container.querySelectorAll<HTMLElement>(opts.itemSelector));
  const itemOf = (target: EventTarget | null) => (target instanceof HTMLElement ? target.closest<HTMLElement>(opts.itemSelector) : null);
  const clearMarks = () => {
    for (const el of items()) el.removeClass("is-drop-before", "is-drop-after", "is-dragging");
  };
  const disarm = () => {
    if (armed) armed.draggable = false;
    armed = null;
  };

  const onMouseDown = (evt: MouseEvent) => {
    const target = evt.target instanceof HTMLElement ? evt.target : null;
    if (!target) return;
    if (opts.handleSelector && !target.closest(opts.handleSelector)) return;
    // Text inputs and buttons inside a row keep their own mouse behaviour.
    if (!opts.handleSelector && target.closest("input, textarea, button, select, [contenteditable=true], [contenteditable=plaintext-only]")) return;
    const item = itemOf(target);
    if (!item || !container.contains(item)) return;
    armed = item;
    item.draggable = true;
  };
  const onDragStart = (evt: DragEvent) => {
    const item = itemOf(evt.target);
    if (!item || item !== armed) {
      evt.preventDefault();
      return;
    }
    from = items().indexOf(item);
    item.addClass("is-dragging");
    if (evt.dataTransfer) {
      evt.dataTransfer.effectAllowed = "move";
      evt.dataTransfer.setData("text/plain", String(from));
    }
  };
  const onDragOver = (evt: DragEvent) => {
    if (from < 0) return;
    const item = itemOf(evt.target);
    if (!item) return;
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
    const rect = item.getBoundingClientRect();
    const before = evt.clientY < rect.top + rect.height / 2;
    const index = items().indexOf(item);
    if (index === overIndex && before === overBefore) return;
    clearMarks();
    items()[from]?.addClass("is-dragging");
    overIndex = index;
    overBefore = before;
    if (index !== from) item.addClass(before ? "is-drop-before" : "is-drop-after");
  };
  const onDrop = (evt: DragEvent) => {
    if (from < 0 || overIndex < 0) return;
    evt.preventDefault();
    let to = overBefore ? overIndex : overIndex + 1;
    if (to > from) to--;
    const moved = to !== from;
    const fromIndex = from;
    finish();
    if (moved) opts.onReorder(fromIndex, to);
  };
  const finish = () => {
    clearMarks();
    disarm();
    from = -1;
    overIndex = -1;
  };

  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("mouseup", disarm);
  container.addEventListener("dragstart", onDragStart);
  container.addEventListener("dragover", onDragOver);
  container.addEventListener("drop", onDrop);
  container.addEventListener("dragend", finish);
  return () => {
    container.removeEventListener("mousedown", onMouseDown);
    container.removeEventListener("mouseup", disarm);
    container.removeEventListener("dragstart", onDragStart);
    container.removeEventListener("dragover", onDragOver);
    container.removeEventListener("drop", onDrop);
    container.removeEventListener("dragend", finish);
  };
}

export function moveItem<T>(list: T[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}
