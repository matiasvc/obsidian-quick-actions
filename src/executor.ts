import { App, MarkdownView, Notice, TFile, TFolder } from "obsidian";
import { Action, ModelConfig, OutputType, Step } from "./types";
import { STEP_DEFS, modelOf, outputsOf, stepLabel } from "./steps";
import { ResolveOptions, cleanedInPaths, namesUsedBy, resolveStep } from "./variables";
import { findUrl, notePath, pathToLink } from "./text";
import { InsertPreview, Splice, applySplice, findHeadingLine, findInsertSpot, findInserted, insertContext, insertEdit } from "./insert";
import { askModel, askModelStructured } from "./llm";
import { fetchPage } from "./fetch";
import { findQuickTasks } from "./quicktasks";
import { openChoiceModal, openFilePickerModal, openPromptModal } from "./modals";
import { rememberAction, rememberFile } from "./recent";
import { RunProgress, StepEvent } from "./progress";
import { NoticeLink, UNDO_NOTICE_MS, linkNotice } from "./ui";

declare const window: Window & { moment: typeof import("moment") };

export interface RunOptions {
  write: boolean; // false for a dry run, where prompts, fetches and models run and nothing is written
  from?: number; // first step index, default 0
  to?: number; // exclusive end, default all steps
  vars?: Record<string, string>; // values captured by an earlier run, built-ins included
  preset?: Record<string, string>; // values from a URI, which Ask me, Choice and Pick a file steps take instead of asking
  onStep?: (event: StepEvent) => void;
  cancelled?: () => boolean;
}

// What a run changed in the vault, so Undo can put it back.
export type Write = { kind: "folder"; path: string } | { kind: "create"; path: string } | { kind: "insert"; path: string; text: string; line: number };

interface Output {
  name: string;
  type: OutputType;
  value: string;
}

export interface StepResult {
  index: number;
  status: "ok" | "skipped" | "cancelled" | "failed";
  resolved: Record<string, string>; // templated fields after substitution
  outputs: Output[];
  note?: string; // what happened, or would have happened in a dry run
  error?: string;
  writes?: Write[];
  preview?: InsertPreview;
  ms: number;
}

export interface RunResult {
  steps: StepResult[];
  vars: Record<string, string>;
  status: "ok" | "cancelled" | "failed";
  ms: number;
}

// How a run resolves its templates: links in the vault's format, and paths that clean typed and
// generated text. The editor's preview uses the same, so it shows what a run writes.
export function resolveOptions(app: App, steps: Step[]): ResolveOptions {
  const clean = cleanedInPaths(steps);
  return {
    link: (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.fileManager.generateMarkdownLink(file, "") : pathToLink(path);
    },
    clean: (name) => clean.has(name),
  };
}

// Runs the step pipeline. Returns the captured vars so a later run can continue from them.
export async function runAction(app: App, action: Action, models: ModelConfig[], opts: RunOptions): Promise<RunResult> {
  const preset = opts.preset ?? {};
  // A continued run already holds the built-ins its first part read.
  const vars = opts.vars ? { ...preset, ...opts.vars } : { ...(await builtinVars(app, namesUsedBy(action.steps))), ...preset };
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? action.steps.length, action.steps.length);
  const ctx: StepContext = { app, action, models, opts, vars, resolve: resolveOptions(app, action.steps) };
  const results: StepResult[] = [];
  const start = Date.now();
  let status: RunResult["status"] = "ok";

  for (let i = from; i < to; i++) {
    const step = action.steps[i];
    if (opts.cancelled?.()) {
      results.push({ ...cancelled("Cancelled"), index: i });
      status = "cancelled";
      break;
    }
    const given = presetOutputs(step, opts.preset);
    if (given) {
      results.push(produce({ ...ok(), index: i }, vars, given));
      continue;
    }
    opts.onStep?.({ index: i, step });
    const stepStart = Date.now();
    let result: StepResult;
    try {
      result = await executeStep(ctx, step, i);
    } catch (e) {
      result = failed(e instanceof Error ? e.message : String(e));
    }
    result.index = i;
    result.ms = Date.now() - stepStart;
    results.push(result);
    if (result.status === "cancelled" || result.status === "failed") {
      status = result.status;
      break;
    }
  }
  return { steps: results, vars, status, ms: Date.now() - start };
}

// A step's outputs from URI values, when its type takes them and every output has one.
function presetOutputs(step: Step, preset?: Record<string, string>): Output[] | null {
  if (!preset || !STEP_DEFS[step.type].fromUri) return null;
  const outs = outputsOf(step);
  if (!outs.every((o) => o.name in preset)) return null;
  return outs.map((o) => ({ ...o, value: o.type === "file" ? notePath(preset[o.name]) : preset[o.name] }));
}

// A full run that writes, for commands, the launcher, the ribbon and URIs. One notice shows
// progress, a failure offers Retry from the failed step, and Undo covers everything written,
// including what a run wrote before it failed and was retried.
export async function executeAction(
  app: App,
  action: Action,
  models: ModelConfig[],
  opts: { preset?: Record<string, string>; from?: number; vars?: Record<string, string>; priorWrites?: Write[] } = {},
): Promise<void> {
  if (opts.from === undefined) rememberAction(app, action.id);
  const progress = new RunProgress(action.name, action.steps.length, models);
  const run = await runAction(app, action, models, {
    write: true,
    from: opts.from,
    vars: opts.vars,
    preset: opts.preset,
    onStep: (e) => progress.step(e),
    cancelled: () => progress.cancelled,
  });
  progress.hide();

  const writes = [...(opts.priorWrites ?? []), ...run.steps.flatMap((r) => r.writes ?? [])];
  const last = run.steps[run.steps.length - 1];
  if (run.status === "failed" && last) {
    console.error(`Quick Actions "${action.name}" step ${last.index + 1} failed:`, last.error);
    failureNotice(app, action, models, last, run.vars, writes, opts.preset);
    return;
  }
  if (run.status === "cancelled") {
    if (writes.length > 0) linkNotice([last?.note ?? "Cancelled"], [undoLink(app, writes)], UNDO_NOTICE_MS);
    else if (last?.note) new Notice(last.note);
    return;
  }
  const notes = run.steps.map((r) => r.note).filter((n): n is string => !!n);
  if (notes.length > 0 || writes.length > 0) linkNotice(notes, writes.length > 0 ? [undoLink(app, writes)] : [], writes.length > 0 ? UNDO_NOTICE_MS : undefined);
}

function failureNotice(
  app: App,
  action: Action,
  models: ModelConfig[],
  last: StepResult,
  vars: Record<string, string>,
  writes: Write[],
  preset?: Record<string, string>,
): void {
  const i = last.index;
  const links: NoticeLink[] = [{ text: `Retry step ${i + 1}`, click: () => void executeAction(app, action, models, { from: i, vars, preset, priorWrites: writes }) }];
  // What you typed into Ask me steps, so nothing typed is lost even when Retry can't help.
  const typed = action.steps
    .slice(0, i)
    .flatMap((s) => (s.type === "prompt" && vars[s.variable] ? [vars[s.variable]] : []))
    .join("\n\n");
  if (typed) {
    links.push({
      text: "Copy what you typed",
      keep: true,
      click: () => {
        navigator.clipboard.writeText(typed).then(
          () => new Notice("Copied what you typed"),
          () => new Notice("Couldn't reach the clipboard"),
        );
      },
    });
  }
  if (writes.length > 0) links.push(undoLink(app, writes));
  linkNotice([`${stepLabel(action.steps[i], models)}: ${last.error ?? "failed"}`], links, 0, `${action.name} stopped at step ${i + 1} of ${action.steps.length}`);
}

function undoLink(app: App, writes: Write[]): NoticeLink {
  return {
    text: "Undo",
    click: () => {
      undoWrites(app, writes).then(
        (missed) => new Notice(missed.length ? `Undone, except ${missed.join(", ")}, which changed since` : "Undone"),
        (e: unknown) => new Notice(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`),
      );
    },
  };
}

// Puts back what a run wrote, newest first: inserted lines come out, created notes go to the
// trash, and folders the run created go too when they are empty. Returns the paths whose inserted
// text it could not find.
export async function undoWrites(app: App, writes: Write[]): Promise<string[]> {
  const missed: string[] = [];
  for (const w of [...writes].reverse()) {
    const file = app.vault.getAbstractFileByPath(w.path);
    if (w.kind === "insert") {
      const found = file instanceof TFile && (await spliceNote(app, file, (text) => findInserted(text, w.text, w.line)));
      if (!found) missed.push(w.path);
    } else if (w.kind === "create") {
      if (file instanceof TFile) await app.fileManager.trashFile(file);
    } else if (file instanceof TFolder && file.children.length === 0) {
      await app.fileManager.trashFile(file);
    }
  }
  return missed;
}

// Date and time always. The selection and the active note are read as the run starts, before any
// prompt takes the focus. The clipboard is only read when a step uses it.
export async function builtinVars(app: App, used: Set<string>): Promise<Record<string, string>> {
  const now = window.moment();
  const vars: Record<string, string> = {
    date: now.format("YYYY-MM-DD"),
    time: now.format("HH:mm"),
    timestamp: now.format("YYYYMMDDHHmmss"),
  };
  const recent = app.workspace.getMostRecentLeaf()?.view;
  const view = app.workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null);
  vars.selection = view?.editor.getSelection() ?? "";
  const file = view?.file ?? app.workspace.getActiveFile();
  vars.active_note = file?.path ?? "";
  vars.active_title = file?.basename ?? "";
  if (used.has("clipboard")) {
    try {
      vars.clipboard = await navigator.clipboard.readText();
    } catch {
      vars.clipboard = "";
    }
  }
  return vars;
}

function ok(resolved: Record<string, string> = {}): StepResult {
  return { index: -1, status: "ok", resolved, outputs: [], ms: 0 };
}

function cancelled(note?: string): StepResult {
  return { ...ok(), status: "cancelled", note };
}

function failed(error: string, resolved: Record<string, string> = {}): StepResult {
  return { ...ok(resolved), status: "failed", error };
}

function produce(result: StepResult, vars: Record<string, string>, values: Output[]): StepResult {
  for (const v of values) {
    vars[v.name] = v.value;
    result.outputs.push(v);
  }
  return result;
}

// The editor of a note open for editing in some tab. A note in reading view has no typing to
// protect, and an edit to its hidden editor is never saved.
function openEditor(app: App, path: string) {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === "source") return view.editor;
  }
  return null;
}

// Changes a note through its editor when it is open for editing, so the change lands next to
// unsaved typing, and through vault.process otherwise. `plan` gets the note's current text and
// returns the edit, or null to leave the note alone. Returns whether it changed the note.
async function spliceNote(app: App, file: TFile, plan: (text: string) => Splice | null): Promise<boolean> {
  const editor = openEditor(app, file.path);
  if (editor) {
    const s = plan(editor.getValue());
    if (!s) return false;
    editor.replaceRange(s.insert, editor.offsetToPos(s.from), editor.offsetToPos(s.to));
    return true;
  }
  let changed = false;
  await app.vault.process(file, (data) => {
    const s = plan(data);
    changed = s !== null;
    return s ? applySplice(data, s) : data;
  });
  return changed;
}

// The missing folders above `path`, top first. Created unless this is a dry run.
async function ensureFolders(app: App, path: string, write: boolean): Promise<string[]> {
  const parts = path.split("/").slice(0, -1);
  const created: string[] = [];
  for (let n = 1; n <= parts.length; n++) {
    const folder = parts.slice(0, n).join("/");
    const existing = app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`${folder} is a file, not a folder`);
    if (write) await app.vault.createFolder(folder);
    created.push(folder);
  }
  return created;
}

// Creates a note and the folders above it, or in a dry run says what it would create.
async function createNote(app: App, path: string, content: string, write: boolean): Promise<{ note: string; writes: Write[] }> {
  const folders = await ensureFolders(app, path, write);
  const inFolder = folders.length ? ` in a new folder, ${folders[folders.length - 1]}` : "";
  if (!write) return { note: `Would create ${path}${inFolder}`, writes: [] };
  await app.vault.create(path, content);
  return { note: `Created ${path}${inFolder}`, writes: [...folders.map((f): Write => ({ kind: "folder", path: f })), { kind: "create", path }] };
}

interface StepContext {
  app: App;
  action: Action;
  models: ModelConfig[];
  opts: RunOptions;
  vars: Record<string, string>;
  resolve: ResolveOptions;
}

async function executeStep(ctx: StepContext, step: Step, i: number): Promise<StepResult> {
  const { app, action, models, opts, vars } = ctx;
  const write = opts.write;
  const resolved = resolveStep(step, vars, ctx.resolve);
  // Drafts and recent picks follow the step's output, so reordering steps keeps them.
  const key = `${action.id}-${"variable" in step ? step.variable : i}`;

  switch (step.type) {
    case "prompt": {
      const value = await openPromptModal(app, { title: action.name, label: step.label, multiline: step.multiline, initial: resolved.default, draftKey: key });
      if (value === null) return cancelled();
      return produce(ok(), vars, [{ name: step.variable, type: "text", value }]);
    }
    case "file_picker": {
      const folder = resolved.folder;
      const value = await openFilePickerModal(app, folder, step.label, key);
      if (value === undefined) return failed(`No notes in ${folder || "the vault"}`, resolved);
      if (value === null) return cancelled();
      rememberFile(app, key, value);
      return produce(ok(resolved), vars, [{ name: step.variable, type: "file", value }]);
    }
    case "choice": {
      const value = await openChoiceModal(app, step.label, step.options);
      if (value === null) return cancelled();
      return produce(ok(), vars, [{ name: step.variable, type: "text", value }]);
    }
    case "quick_task": {
      const found = findQuickTasks(app);
      if ("error" in found) return failed(found.error);
      const qa = await found.api.askTask({ project: resolved.project || undefined, prefill: resolved.prefill || undefined });
      if (!qa) return cancelled();
      if (!write) {
        // A placeholder with the real shape, so later steps can preview "![[{{task}}]]".
        const result = produce(ok(resolved), vars, [{ name: step.variable, type: "file", value: `${found.api.folder}/T-new.md` }]);
        result.note = `Would create task ${found.api.summary(qa)}`;
        return result;
      }
      const path = await found.api.createTask(qa);
      const result = produce(ok(resolved), vars, [{ name: step.variable, type: "file", value: path }]);
      result.note = `Created task “${qa.title}”`;
      return result;
    }
    case "llm": {
      const config = modelOf(step, models);
      if (!config) return failed(step.model ? `Model "${step.model}" is not configured. Pick another in the step.` : "No models are configured");
      try {
        if (step.outputs.length > 0) {
          const values = await askModelStructured(app, config, resolved.system_prompt, resolved.user_prompt, step.outputs);
          if (opts.cancelled?.()) return cancelled("Cancelled");
          return produce(ok(resolved), vars, step.outputs.map((o) => ({ name: o.name, type: "text" as const, value: values[o.name] })));
        }
        const reply = await askModel(app, config, resolved.system_prompt, resolved.user_prompt);
        if (opts.cancelled?.()) return cancelled("Cancelled");
        return produce(ok(resolved), vars, [{ name: step.variable, type: "text", value: reply }]);
      } catch (e) {
        return failed(`${config.name}: ${e instanceof Error ? e.message : String(e)}`, resolved);
      }
    }
    case "fetch_page": {
      const url = findUrl(resolved.url);
      if (!url) {
        if (step.noUrl === "fail") return failed("No URL in the value", resolved);
        const result = produce(ok(resolved), vars, [
          { name: step.variable, type: "text", value: resolved.url },
          { name: step.titleVariable, type: "text", value: "" },
        ]);
        result.note = "No URL, so the text was used as the page";
        return result;
      }
      try {
        const page = await fetchPage(url);
        return produce(ok(resolved), vars, [
          { name: step.variable, type: "text", value: page.markdown },
          { name: step.titleVariable, type: "text", value: page.title },
        ]);
      } catch (e) {
        return failed(`${url}: ${e instanceof Error ? e.message : String(e)}`, resolved);
      }
    }
    case "create_file": {
      const result = produce(ok(resolved), vars, [{ name: step.variable, type: "file", value: resolved.path }]);
      if (app.vault.getAbstractFileByPath(resolved.path)) {
        result.note = `File already exists: ${resolved.path}`;
        return result;
      }
      const created = await createNote(app, resolved.path, resolved.content, write);
      result.note = created.note;
      result.writes = created.writes;
      return result;
    }
    case "insert_in_section":
      return insertStep(ctx, step, resolved);
    case "open_file": {
      if (!write) return { ...ok(resolved), status: "skipped", note: "Not run" };
      const file = app.vault.getAbstractFileByPath(resolved.target);
      if (!(file instanceof TFile)) return failed(`File not found: ${resolved.target}`, resolved);
      const leaf = step.openIn === "tab" ? app.workspace.getLeaf("tab") : step.openIn === "split" ? app.workspace.getLeaf("split", "vertical") : app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true });
      if (resolved.section && leaf.view instanceof MarkdownView) placeCursorUnder(leaf.view, resolved.section);
      return ok(resolved);
    }
  }
}

async function insertStep(ctx: StepContext, step: Extract<Step, { type: "insert_in_section" }>, resolved: Record<string, string>): Promise<StepResult> {
  const { app } = ctx;
  const write = ctx.opts.write;
  const { target, section, format, templatePath } = resolved;
  const existing = app.vault.getAbstractFileByPath(target);
  if (existing && !(existing instanceof TFile)) return failed(`Not a file: ${target}`, resolved);

  if (existing instanceof TFile) {
    // Plan against the text the write will change: the open editor's, else the file's.
    const content = openEditor(app, existing.path)?.getValue() ?? (await app.vault.cachedRead(existing));
    const spot = findInsertSpot(content, section, step.position);
    if ("error" in spot) return failed(`${spot.error} in ${target}`, resolved);
    const result = ok(resolved);
    result.preview = insertContext(spot, format);
    if (!write) {
      result.note = `Would insert at line ${spot.at + 1} of ${target}`;
      return result;
    }
    let line = spot.at;
    await spliceNote(app, existing, (text) => {
      const current = findInsertSpot(text, section, step.position);
      if ("error" in current) throw new Error(`${current.error} in ${target}`);
      line = current.at;
      return insertEdit(current, format);
    });
    result.writes = [{ kind: "insert", path: target, text: format, line }];
    result.note = `Added to ${target} under ${section}`;
    return result;
  }

  if (!step.createIfMissing) return failed(`File not found: ${target}`, resolved);
  let initial = section + "\n";
  if (step.templatePath) {
    const template = app.vault.getAbstractFileByPath(templatePath);
    if (!(template instanceof TFile)) return failed(`Template not found: ${templatePath}`, resolved);
    initial = await app.vault.read(template);
  }
  const spot = findInsertSpot(initial, section, step.position);
  if ("error" in spot) return failed(`${spot.error} in the template`, resolved);
  const result = ok(resolved);
  result.preview = insertContext(spot, format);
  const created = await createNote(app, target, applySplice(initial, insertEdit(spot, format)), write);
  result.note = created.note;
  result.writes = created.writes;
  return result;
}

// Puts the cursor on the line under a heading, found in the editor's own text so a note created a
// moment ago works before the metadata cache has read it.
function placeCursorUnder(view: MarkdownView, section: string): void {
  const editor = view.editor;
  const line = findHeadingLine(editor.getValue().split("\n"), section, true);
  if (line === -1) return;
  const target = Math.min(line + 1, editor.lastLine());
  editor.setCursor({ line: target, ch: 0 });
  editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: target, ch: 0 } }, true);
  editor.focus();
}
