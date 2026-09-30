// The only file that knows about the Quick Tasks plugin. Nothing is imported from it: the
// contract is the api object on its plugin instance, mirrored here and checked by version.
import type { App } from "obsidian";

export const QUICK_TASKS_API_VERSION = 2;

// What the quick-add box parsed. Opaque apart from the title: handed back to createTask and
// summary untouched, so Quick Tasks alone knows its fields.
export interface QuickTaskDraft {
  title: string;
}

export interface QuickTasksApi {
  version: number;
  folder: string;
  askTask(opts: { project?: string; prefill?: string }): Promise<QuickTaskDraft | null>;
  createTask(qa: QuickTaskDraft): Promise<string>;
  // “Pay rent” · due Thu, Sep 5 · High · #home · @Garden · Every week
  summary(qa: QuickTaskDraft): string;
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
