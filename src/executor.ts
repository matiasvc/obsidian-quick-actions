import { App, Notice, TFile } from "obsidian";
import { Action, Step, ModelConfig, OutputType } from "./types";
import { STEP_DEFS } from "./steps";
import { resolveTemplate } from "./variables";
import { callLLM, findModel } from "./llm";
import { openPromptModal, openFilePickerModal, openChoiceModal } from "./modals";

declare const window: Window & { moment: typeof import("moment") };

export interface RunOptions {
  write: boolean; // false = dry run: prompts and models run, the vault is never written
  from?: number; // first step index, default 0
  to?: number; // exclusive end, default all steps
  vars?: Record<string, string>; // values captured by an earlier run, on top of the built-ins
}

export interface StepResult {
  index: number;
  status: "ok" | "skipped" | "cancelled" | "failed";
  resolved: Record<string, string>; // templated fields after substitution
  unresolved: string[]; // names left verbatim in the resolved fields
  output?: { name: string; type: OutputType; value: string };
  note?: string; // what happened, or would have happened in a dry run
  error?: string;
  ms: number;
}

export interface RunResult {
  steps: StepResult[];
  vars: Record<string, string>;
  status: "ok" | "cancelled" | "failed";
  ms: number;
}

// Runs the step pipeline. Mutates and returns vars so a later run can continue from them.
export async function runAction(app: App, action: Action, models: ModelConfig[], opts: RunOptions): Promise<RunResult> {
  const vars = { ...getBuiltinVars(), ...(opts.vars ?? {}) };
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? action.steps.length, action.steps.length);
  const results: StepResult[] = [];
  const start = Date.now();
  let status: RunResult["status"] = "ok";

  for (let i = from; i < to; i++) {
    const step = action.steps[i];
    const stepStart = Date.now();
    let result: StepResult;
    try {
      result = await executeStep(app, step, vars, models, opts.write);
    } catch (e) {
      result = { index: i, status: "failed", resolved: {}, unresolved: [], error: String(e), ms: 0 };
    }
    result.index = i;
    result.ms = Date.now() - stepStart;
    result.unresolved = unresolvedIn(result.resolved);
    results.push(result);
    if (result.status === "cancelled") {
      status = "cancelled";
      break;
    }
    if (result.status === "failed") {
      status = "failed";
      break;
    }
  }
  return { steps: results, vars, status, ms: Date.now() - start };
}

// The command-palette entry point: a full run that writes, reporting through Notices.
export async function executeAction(app: App, action: Action, models: ModelConfig[]): Promise<void> {
  const run = await runAction(app, action, models, { write: true });
  for (const r of run.steps) {
    if (r.note) new Notice(r.note);
    if (r.error) {
      console.error(`Quick Actions "${action.name}" step ${r.index + 1} failed:`, r.error);
      new Notice(`Action "${action.name}" failed: ${r.error}`);
    }
  }
}

export function getBuiltinVars(): Record<string, string> {
  const now = window.moment();
  return {
    date: now.format("YYYY-MM-DD"),
    time: now.format("HH:mm"),
    timestamp: now.format("YYYYMMDDHHmmss"),
  };
}

function unresolvedIn(resolved: Record<string, string>): string[] {
  const names: string[] = [];
  for (const v of Object.values(resolved)) {
    for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

interface TasksPluginApi {
  apiV1?: { createTaskLineModal?: () => Promise<string | null> };
}
interface ObsidianAppInternal {
  plugins?: { plugins?: Record<string, TasksPluginApi> };
}

interface ViewWithScroll {
  currentMode?: { applyScroll?: (line: number) => void };
}

function ensureMdExtension(path: string): string {
  if (!path.endsWith(".md")) return path + ".md";
  return path;
}

function ok(resolved: Record<string, string> = {}): StepResult {
  return { index: -1, status: "ok", resolved, unresolved: [], ms: 0 };
}

function cancelled(note?: string): StepResult {
  return { index: -1, status: "cancelled", resolved: {}, unresolved: [], note, ms: 0 };
}

function failed(error: string, resolved: Record<string, string> = {}): StepResult {
  return { index: -1, status: "failed", resolved, unresolved: [], error, ms: 0 };
}

function produce(result: StepResult, step: Step & { variable: string }, value: string, vars: Record<string, string>): StepResult {
  vars[step.variable] = value;
  result.output = { name: step.variable, type: STEP_DEFS[step.type].output ?? "text", value };
  return result;
}

async function executeStep(app: App, step: Step, vars: Record<string, string>, models: ModelConfig[], write: boolean): Promise<StepResult> {
  switch (step.type) {
    case "prompt": {
      const value = await openPromptModal(app, step.label, step.multiline);
      if (value === null) return cancelled();
      return produce(ok(), step, value, vars);
    }
    case "file_picker": {
      const folder = resolveTemplate(step.folder, vars);
      const value = await openFilePickerModal(app, folder);
      if (value === null) return cancelled("No files found or selection cancelled");
      return produce(ok({ folder }), step, value, vars);
    }
    case "tasks_modal": {
      const tasksPlugin = (app as unknown as ObsidianAppInternal).plugins?.plugins?.["obsidian-tasks-plugin"];
      if (!tasksPlugin?.apiV1?.createTaskLineModal) return failed("Tasks plugin not available");
      const taskLine = await tasksPlugin.apiV1.createTaskLineModal();
      if (!taskLine) return cancelled();
      return produce(ok(), step, taskLine, vars);
    }
    case "choice": {
      const value = await openChoiceModal(app, step.label, step.options);
      if (value === null) return cancelled();
      return produce(ok(), step, value, vars);
    }
    case "llm": {
      const config = findModel(models, step.model);
      if (!config) return failed(`Model "${step.model || "(none)"}" not configured`);
      const resolved = { system_prompt: resolveTemplate(step.system_prompt, vars), user_prompt: resolveTemplate(step.user_prompt, vars) };
      const apiKey = app.secretStorage.getSecret(config.secret_id);
      if (!apiKey) return failed(`No secret named "${config.secret_id}" for model ${config.name}`, resolved);
      const notice = new Notice(`Generating ${step.variable}...`, 0);
      try {
        const reply = await callLLM(config.provider, config.model, apiKey, resolved.system_prompt, resolved.user_prompt);
        return produce(ok(resolved), step, reply, vars);
      } catch (e) {
        return failed(`${config.name}: ${e instanceof Error ? e.message : String(e)}`, resolved);
      } finally {
        notice.hide();
      }
    }
    case "create_file": {
      const path = ensureMdExtension(resolveTemplate(step.path, vars));
      const content = resolveTemplate(step.content, vars);
      const resolved = { path, content };
      const result = produce(ok(resolved), step, path, vars);
      if (app.vault.getAbstractFileByPath(path)) {
        result.note = `File already exists: ${path}`;
        return result;
      }
      if (!write) {
        result.note = `Would create ${path}`;
        return result;
      }
      await app.vault.create(path, content);
      result.note = `Created ${path}`;
      return result;
    }
    case "insert_in_section": {
      const resolved = {
        target: ensureMdExtension(resolveTemplate(step.target, vars)),
        section: resolveTemplate(step.section, vars),
        format: resolveTemplate(step.format, vars),
        templatePath: resolveTemplate(step.templatePath, vars),
      };
      const plan = await planInsert(app, resolved.target, resolved.section, step.position, step.createIfMissing, resolved.templatePath);
      if ("error" in plan) return failed(plan.error, resolved);
      const result = ok(resolved);
      const where = `${plan.lines.length ? "line " + (plan.insertAt + 1) : "top"} of ${resolved.target}`;
      if (!write) {
        result.note = plan.file ? `Would insert at ${where}` : `Would create ${resolved.target} and insert at ${where}`;
        return result;
      }
      await writeInsert(app, plan, resolved.format);
      result.note = `Updated ${resolved.target}`;
      return result;
    }
    case "open_file": {
      const resolved = { target: ensureMdExtension(resolveTemplate(step.target, vars)), section: resolveTemplate(step.section, vars) };
      if (!write) return { ...ok(resolved), status: "skipped", note: "Not run" };
      const file = app.vault.getAbstractFileByPath(resolved.target);
      if (!(file instanceof TFile)) return failed(`File not found: ${resolved.target}`, resolved);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
      if (resolved.section) {
        const headingText = resolved.section.replace(/^#+\s*/, "");
        const cache = app.metadataCache.getFileCache(file);
        const heading = cache?.headings?.find((h) => h.heading === headingText);
        if (heading) {
          const view = leaf.view as unknown as ViewWithScroll;
          view?.currentMode?.applyScroll?.(heading.position.start.line);
        }
      }
      return ok(resolved);
    }
  }
}

export interface InsertPlan {
  path: string;
  file: TFile | null; // null when the file does not exist yet and will be created
  initial: string; // content of a file to be created
  lines: string[];
  insertAt: number;
}

// Locates where the text would go. Reads the vault, never writes it.
export async function planInsert(
  app: App,
  targetPath: string,
  section: string,
  position: "beginning" | "end",
  createIfMissing: boolean,
  templatePath: string,
): Promise<InsertPlan | { error: string }> {
  const existing = app.vault.getAbstractFileByPath(targetPath);
  let file: TFile | null = null;
  let content: string;
  if (existing instanceof TFile) {
    file = existing;
    content = await app.vault.read(file);
  } else if (existing) {
    return { error: `Not a file: ${targetPath}` };
  } else if (!createIfMissing) {
    return { error: `File not found: ${targetPath}` };
  } else if (templatePath) {
    const template = app.vault.getAbstractFileByPath(ensureMdExtension(templatePath));
    if (!(template instanceof TFile)) return { error: `Template not found: ${templatePath}` };
    content = await app.vault.read(template);
  } else {
    content = section + "\n";
  }

  const lines = content.split("\n");
  const sectionLevel = section.match(/^(#+)/)?.[1].length ?? 1;
  const sectionIndex = lines.findIndex((l) => l.trimEnd() === section);
  if (sectionIndex === -1) return { error: `Section "${section}" not found in ${targetPath}` };

  let insertAt: number;
  if (position === "beginning") {
    insertAt = sectionIndex + 1;
  } else {
    // Before the next heading of the same or higher level, or the end of the file,
    // skipping trailing blank lines so the entry sits right after the content.
    insertAt = lines.length;
    for (let i = sectionIndex + 1; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#+)\s/);
      if (headingMatch && headingMatch[1].length <= sectionLevel) {
        insertAt = i;
        break;
      }
    }
    while (insertAt > sectionIndex + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  }
  return { path: targetPath, file, initial: content, lines, insertAt };
}

export async function writeInsert(app: App, plan: InsertPlan, text: string): Promise<void> {
  const lines = [...plan.lines];
  lines.splice(plan.insertAt, 0, text);
  if (plan.file) {
    await app.vault.modify(plan.file, lines.join("\n"));
  } else {
    await app.vault.create(plan.path, lines.join("\n"));
  }
}
