// What this device remembers between runs: unsent prompt text, recently picked files and when each
// action last ran. Kept in Obsidian's per-vault local storage, never in data.json, so it stays on
// the device and never syncs.
import { App } from "obsidian";

const DRAFT_MS = 24 * 60 * 60 * 1000;
const RECENT_FILES = 5;

interface Draft {
  text: string;
  at: number;
}

function load<T>(app: App, key: string): T | null {
  return (app.loadLocalStorage(key) as T | null) ?? null;
}

export function loadDraft(app: App, key: string): Draft | null {
  const draft = load<Draft>(app, `quick-actions-draft-${key}`);
  return draft && Date.now() - draft.at < DRAFT_MS && draft.text ? draft : null;
}

export function saveDraft(app: App, key: string, text: string): void {
  app.saveLocalStorage(`quick-actions-draft-${key}`, text ? { text, at: Date.now() } : null);
}

export function recentFiles(app: App, key: string): string[] {
  return load<string[]>(app, `quick-actions-files-${key}`) ?? [];
}

export function rememberFile(app: App, key: string, path: string): void {
  const list = [path, ...recentFiles(app, key).filter((p) => p !== path)].slice(0, RECENT_FILES);
  app.saveLocalStorage(`quick-actions-files-${key}`, list);
}

export function actionUses(app: App): Record<string, number> {
  return load<Record<string, number>>(app, "quick-actions-used") ?? {};
}

export function rememberAction(app: App, id: string): void {
  app.saveLocalStorage("quick-actions-used", { ...actionUses(app), [id]: Date.now() });
}
