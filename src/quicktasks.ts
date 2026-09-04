// The only file that knows about the Quick Tasks plugin. Nothing is imported from it: the
// contract is the api object on its plugin instance, mirrored here and checked by version.
import type { App } from "obsidian";

export const QUICK_TASKS_API_VERSION = 1;

// What the quick-add box parsed. Passed back to createTask untouched; read only for the summary.
export interface QuickTaskDraft {
  title: string;
  due: string | null;
  priority: "high" | "medium" | "low" | "none";
  tags: string[];
  project: string | null;
  repeat: { text: string } | null;
}

export interface QuickTasksApi {
  version: number;
  folder: string;
  askTask(opts: { project?: string; prefill?: string }): Promise<QuickTaskDraft | null>;
  createTask(qa: QuickTaskDraft): Promise<string>;
}

interface AppWithPlugins {
  plugins?: { plugins?: Record<string, { api?: Partial<QuickTasksApi> } | undefined> };
}

// Looked up on every call: the plugin can be enabled or disabled while Obsidian runs, and
// Obsidian drops the entry while it is disabled.
export function findQuickTasks(app: App): { api: QuickTasksApi } | { error: string } {
  const api = (app as unknown as AppWithPlugins).plugins?.plugins?.["quick-tasks"]?.api;
  if (!api || typeof api.askTask !== "function" || typeof api.createTask !== "function") {
    return { error: "Quick Tasks plugin is not enabled" };
  }
  if (api.version !== QUICK_TASKS_API_VERSION) {
    return { error: `Quick Tasks API version ${String(api.version)}, this plugin expects ${QUICK_TASKS_API_VERSION}` };
  }
  return { api: api as QuickTasksApi };
}

// “Pay rent” · due 2026-09-05 · high · #home · @Garden · every week
export function taskSummary(qa: QuickTaskDraft): string {
  const parts = [`“${qa.title}”`];
  if (qa.due) parts.push(`due ${qa.due}`);
  if (qa.priority !== "none") parts.push(qa.priority);
  for (const tag of qa.tags) parts.push(`#${tag}`);
  if (qa.project) parts.push(`@${qa.project}`);
  if (qa.repeat) parts.push(qa.repeat.text);
  return parts.join(" · ");
}
