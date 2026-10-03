import { App, MarkdownView, Notice, TFile, TFolder, getLinkpath, moment } from "obsidian";
import { Action, InsertInSectionStep, ModelConfig, OpenIn, OutputType, Page, Step } from "./types";
import { STEP_DEFS, modelOf, outputsOf, stepLabel, usesWeb } from "./steps";
import { BuiltinName, ResolveOptions, cleanedInPaths, namesUsedBy, resolveStep } from "./variables";
import { findUrl, notePath, pathToLink, sourceList } from "./text";
import { InsertPreview, Splice, applySplice, findHeadingLine, findInsertSpot, findInserted, insertContext, insertEdit } from "./insert";
import { Block, blocksOf, branchEnd, isMarker, skipMarkers, stepCount, stepNumbers, testPasses } from "./flow";
import { Attachment, apiKeyFor, askModel, askModelStructured } from "./llm";
import { REQUEST_LIMIT, mediaTypeOf, providerLabel } from "./providers";
import { fetchPage } from "./fetch";
import { findQuickTasks } from "./quicktasks";
import { openChoiceModal, openFilePickerModal, openPromptModal } from "./modals";
import { rememberAction, rememberFile } from "./recent";
import { RunProgress, StepEvent } from "./progress";
import { NoticeLink, UNDO_NOTICE_MS, errorMessage, linkNotice } from "./ui";

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
  status: "ok" | "stopped" | "skipped" | "cancelled" | "failed"; // stopped: a Stop step ended the run, as finished
  resolved: Record<string, string>; // templated fields after substitution
  outputs: Output[];
  note?: string; // what happened, or would have happened in a dry run
  error?: string;
  writes?: Write[];
  preview?: InsertPreview;
  branch?: number; // for an If, the marker of the branch that ran, or -1 when none did
  ms: number;
}

export interface RunResult {
  steps: StepResult[];
  vars: Record<string, string>;
  status: "ok" | "stopped" | "cancelled" | "failed";
  ms: number;
  next: number; // where a continued run starts, past any branch the run skipped
}

// How a run resolves its templates: links in the vault's format, paths that clean typed and
// generated text, and paths to images and PDFs kept as they are. The editor's preview uses the
// same, so it shows what a run writes.
export function resolveOptions(app: App, steps: Step[]): ResolveOptions {
  const clean = cleanedInPaths(steps);
  return {
    link: (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.fileManager.generateMarkdownLink(file, "") : pathToLink(path);
    },
    clean: (name) => clean.has(name),
    exists: (path) => app.vault.getFileByPath(path) !== null,
  };
}

// Runs the step pipeline. Returns the captured vars so a later run can continue from them. An If
// block runs one of its branches and skips the rest, and a Stop step ends the run.
export async function runAction(app: App, action: Action, models: ModelConfig[], opts: RunOptions): Promise<RunResult> {
  const steps = action.steps;
  // A continued run already holds the built-ins its first part read. URI values reach the run only
  // through the steps they answer, in presetOutputs.
  const vars = opts.vars ? { ...opts.vars } : await builtinVars(app, namesUsedBy(steps));
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? steps.length, steps.length);
  const ctx: StepContext = { app, action, models, opts, vars, resolve: resolveOptions(app, steps), writer: opts.write ? vaultWriter(app) : testRunWriter(app) };
  const blocks = blocksOf(steps);
  const numbers = stepNumbers(steps);
  const results: StepResult[] = [];
  const start = Date.now();
  let status: RunResult["status"] = "ok";

  let i = skipMarkers(steps, from, blocks);
  while (i < to) {
    const step = steps[i];
    if (opts.cancelled?.()) {
      results.push({ ...cancelled("Cancelled"), index: i });
      status = "cancelled";
      break;
    }
    if (step.type === "if") {
      const block = blocks.get(i);
      const next = block ? runIf(ctx, block, results) : i + 1;
      if (typeof next === "string") {
        results.push({ ...failed(next), index: i });
        status = "failed";
        break;
      }
      i = skipMarkers(steps, next, blocks);
      continue;
    }
    const given = presetOutputs(step, ctx.resolve, opts.preset);
    if (given) {
      results.push(produce({ ...ok(), index: i }, vars, given));
      i = skipMarkers(steps, i + 1, blocks);
      continue;
    }
    opts.onStep?.({ number: numbers[i], step });
    const stepStart = Date.now();
    let result: StepResult;
    try {
      result = await executeStep(ctx, step, i);
    } catch (e) {
      result = failed(errorMessage(e));
    }
    result.index = i;
    result.ms = Date.now() - stepStart;
    results.push(result);
    if (result.status === "stopped" || result.status === "cancelled" || result.status === "failed") {
      status = result.status;
      break;
    }
    i = skipMarkers(steps, i + 1, blocks);
  }
  return { steps: results, vars, status, ms: Date.now() - start, next: i };
}

// Runs an If block's tests and returns where the run goes on: the first step of the first branch
// whose tests pass, of the Else, or past the block. A pattern that can't be matched returns the
// error instead. Outputs of the skipped branches start empty, so a step after the block reads ""
// and not the bare {{name}}, and their steps are marked as not taken.
function runIf(ctx: StepContext, block: Block, results: StepResult[]): number | string {
  const steps = ctx.action.steps;
  let chosen = -1;
  for (const m of block.branches) {
    const s = steps[m];
    if (s.type === "else") {
      chosen = m;
      break;
    }
    if (s.type !== "if" && s.type !== "else_if") continue;
    const r = resolveStep(s, ctx.vars, ctx.resolve);
    const passes: boolean[] = [];
    for (const [n, t] of s.tests.entries()) {
      try {
        passes.push(testPasses(t.op, r[`tests.${n}.value`], r[`tests.${n}.text`]));
      } catch {
        return `“${t.text}” is not a valid pattern`;
      }
    }
    if (passes.length > 0 && (s.match === "any" ? passes.some(Boolean) : passes.every(Boolean))) {
      chosen = m;
      break;
    }
  }
  block.branches.forEach((m, k) => {
    if (m === chosen) return;
    for (let j = m + 1; j < branchEnd(block, k); j++) {
      if (isMarker(steps[j])) continue;
      const empty = outputsOf(steps[j]).filter((out) => !(out.name in ctx.vars));
      const result = produce({ ...ok(), index: j, status: "skipped" }, ctx.vars, empty.map((out) => ({ ...out, value: "" })));
      if (!ctx.opts.write) result.note = "Not taken";
      results.push(result);
    }
  });
  const k = block.branches.indexOf(chosen);
  const which = chosen < 0 ? "No branch ran" : k === 0 ? "The first branch ran" : steps[chosen].type === "else" ? "The Else branch ran" : `Else if ${k} ran`;
  results.push({ ...ok(), index: block.start, branch: chosen, note: ctx.opts.write ? undefined : which });
  return chosen < 0 ? block.end + 1 : chosen + 1;
}

// A step's outputs from URI values, when its type takes them and every output has one.
function presetOutputs(step: Step, resolve: ResolveOptions, preset?: Record<string, string>): Output[] | null {
  if (!preset || !STEP_DEFS[step.type].fromUri) return null;
  const outs = outputsOf(step);
  if (!outs.every((o) => o.name in preset)) return null;
  return outs.map((o) => ({ ...o, value: o.type === "file" ? notePath(preset[o.name], resolve.exists) : preset[o.name] }));
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
  const progress = new RunProgress(action.name, stepCount(action.steps), models);
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
    console.error(`Quick Actions "${action.name}" step ${stepNumbers(action.steps)[last.index]} failed:`, last.error);
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
  const n = stepNumbers(action.steps)[i];
  const links: NoticeLink[] = [{ text: `Retry step ${n}`, click: () => void executeAction(app, action, models, { from: i, vars, preset, priorWrites: writes }) }];
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
  linkNotice([`${stepLabel(action.steps[i], models)}: ${last.error ?? "failed"}`], links, 0, `${action.name} stopped at step ${n} of ${stepCount(action.steps)}`);
}

function undoLink(app: App, writes: Write[]): NoticeLink {
  return {
    text: "Undo",
    click: () => {
      undoWrites(app, writes).then(
        (missed) => new Notice(missed.length ? `Undone, except ${missed.join(", ")}, which changed since` : "Undone"),
        (e: unknown) => new Notice(`Couldn't undo: ${errorMessage(e)}`),
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
// prompt takes the focus. The clipboard is only read when a step uses it, and is otherwise left
// unset.
export async function builtinVars(app: App, used: Set<string>): Promise<Record<string, string>> {
  const now = moment();
  const recent = app.workspace.getMostRecentLeaf()?.view;
  const view = app.workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null);
  const file = view?.file ?? app.workspace.getActiveFile();
  const values: Record<BuiltinName, string | undefined> = {
    date: now.format("YYYY-MM-DD"),
    time: now.format("HH:mm"),
    timestamp: now.format("YYYYMMDDHHmmss"),
    selection: view?.editor.getSelection() ?? "",
    active_note: file?.path ?? "",
    active_title: file?.basename ?? "",
    clipboard: used.has("clipboard") ? await readClipboard() : undefined,
  };
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) if (value !== undefined) vars[name] = value;
  return vars;
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
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

// The missing folders above `path`, top first.
function missingFolders(app: App, path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const missing: string[] = [];
  for (let n = 1; n <= parts.length; n++) {
    const folder = parts.slice(0, n).join("/");
    const existing = app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`${folder} is a file, not a folder`);
    missing.push(folder);
  }
  return missing;
}

function inNewFolder(folders: string[]): string {
  return folders.length ? ` in a new folder, ${folders[folders.length - 1]}` : "";
}

// What a change did, or in a test run would do, and how Undo takes it back.
interface Written {
  note?: string;
  writes: Write[];
  preview?: InsertPreview;
}

// Every change a step makes to the vault or the workspace goes through one of these. A test run
// gets one that runs the same checks and planning, changes nothing and says what it would do, so
// no step has to remember that a test run writes nothing. A failed check throws.
interface Writer {
  create(path: string, content: string): Promise<Written>; // with the folders above it
  insert(file: TFile, section: string, position: InsertInSectionStep["position"], text: string): Promise<Written>;
  open(path: string, openIn: OpenIn, section: string): Promise<Written>; // with the cursor under `section`
}

function vaultWriter(app: App): Writer {
  return {
    async create(path, content) {
      const folders = missingFolders(app, path);
      for (const folder of folders) await app.vault.createFolder(folder);
      await app.vault.create(path, content);
      return { note: `Created ${path}${inNewFolder(folders)}`, writes: [...folders.map((f): Write => ({ kind: "folder", path: f })), { kind: "create", path }] };
    },
    async insert(file, section, position, text) {
      let line = 0;
      await spliceNote(app, file, (content) => {
        const spot = findInsertSpot(content, section, position);
        if ("error" in spot) throw new Error(`${spot.error} in ${file.path}`);
        line = spot.at;
        return insertEdit(spot, text);
      });
      return { note: `Added to ${file.path} under ${section}`, writes: [{ kind: "insert", path: file.path, text, line }] };
    },
    async open(path, openIn, section) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
      const leaf = openIn === "tab" ? app.workspace.getLeaf("tab") : openIn === "split" ? app.workspace.getLeaf("split", "vertical") : app.workspace.getLeaf(false);
      // Scroll to puts the cursor under a heading, which reading view has no place for.
      await leaf.openFile(file, section ? { active: true, state: { mode: "source" } } : { active: true });
      if (section && leaf.view instanceof MarkdownView) placeCursorUnder(leaf.view, section);
      return { writes: [] };
    },
  };
}

function testRunWriter(app: App): Writer {
  return {
    async create(path) {
      return { note: `Would create ${path}${inNewFolder(missingFolders(app, path))}`, writes: [] };
    },
    async insert(file, section, position, text) {
      // Plan against the text a write would change: the open editor's, else the file's.
      const content = openEditor(app, file.path)?.getValue() ?? (await app.vault.cachedRead(file));
      const spot = findInsertSpot(content, section, position);
      if ("error" in spot) throw new Error(`${spot.error} in ${file.path}`);
      return { note: `Would insert at line ${spot.at + 1} of ${file.path}`, writes: [], preview: insertContext(spot, text) };
    },
    // The file may be one an earlier step would create, so it need not exist yet.
    async open(path) {
      return { note: `Would open ${path}`, writes: [] };
    },
  };
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The browser's own base64 encoder. Obsidian's arrayBufferToBase64 builds a string per byte, which
// takes several times longer and holds a large array for a big PDF.
function toBase64(data: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(new Blob([data]));
  });
}

// The images and PDFs an Ask a model step sends, from a comma-separated list of files: each image
// or PDF, and for a note the images and PDFs it embeds. File names can hold commas, so each entry
// is the longest run of pieces that names a file. Before anything is read, the total is checked
// against what the provider takes in one request.
async function readAttachments(app: App, value: string, provider: ModelConfig["provider"]): Promise<Attachment[]> {
  const isAttachable = (f: TFile) => mediaTypeOf(f.extension) !== undefined;
  const pieces = value.split(",");
  const named: TFile[] = [];
  for (let i = 0; i < pieces.length; ) {
    if (!pieces[i].trim()) {
      i++;
      continue;
    }
    let end = pieces.length + 1;
    let file: TFile | null = null;
    while (!file && --end > i) file = app.metadataCache.getFirstLinkpathDest(pieces.slice(i, end).join(",").trim(), "");
    if (!file) throw new Error(`No file at ${pieces[i].trim()} to attach`);
    named.push(file);
    i = end;
  }
  const files: TFile[] = [];
  for (const file of named) {
    if (isAttachable(file)) {
      files.push(file);
    } else if (file.extension === "md") {
      const embeds = (app.metadataCache.getFileCache(file)?.embeds ?? [])
        .map((e) => app.metadataCache.getFirstLinkpathDest(getLinkpath(e.link), file.path))
        .filter((f): f is TFile => f !== null && isAttachable(f));
      if (embeds.length === 0) throw new Error(`${file.basename} embeds no images or PDFs to attach`);
      files.push(...embeds);
    } else {
      throw new Error(`${file.name} can't be attached. A model takes images and PDFs.`);
    }
  }
  const unique = [...new Map(files.map((f) => [f.path, f])).values()];
  const encoded = unique.reduce((sum, f) => sum + Math.ceil(f.stat.size / 3) * 4, 0);
  if (encoded > REQUEST_LIMIT[provider]) {
    const sizes = unique.map((f) => `${f.name} ${megabytes(f.stat.size)}`).join(", ");
    throw new Error(`The attachments (${sizes}) are more than the ${megabytes(REQUEST_LIMIT[provider])} ${providerLabel(provider)} takes in one request`);
  }
  return Promise.all(unique.map(async (f) => ({ name: f.name, mediaType: mediaTypeOf(f.extension) ?? "", data: await toBase64(await app.vault.readBinary(f)) })));
}

interface StepContext {
  app: App;
  action: Action;
  models: ModelConfig[];
  opts: RunOptions;
  vars: Record<string, string>;
  resolve: ResolveOptions;
  writer: Writer;
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
      const value = await openFilePickerModal(app, folder, step.label, key, step.files);
      if (value === undefined) return failed(`No ${step.files === "notes" ? "notes" : "files"} in ${folder || "the vault"}`, resolved);
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
      // Quick Tasks writes the note itself, past the writer, so a test run stops before it.
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
      let attachments: Attachment[];
      try {
        // A missing key fails before any file is read.
        apiKeyFor(app, config);
        attachments = await readAttachments(app, resolved.attach, config.provider);
      } catch (e) {
        return failed(errorMessage(e), resolved);
      }
      try {
        const ask = { webSearch: step.webSearch, webFetch: step.webFetch, effort: step.effort, attachments };
        let values: Output[];
        let pages: Page[];
        if (step.outputs.length > 0) {
          const reply = await askModelStructured(app, config, resolved.system_prompt, resolved.user_prompt, step.outputs, ask);
          values = step.outputs.map((o) => ({ name: o.name, type: "text", value: reply.values[o.name] }));
          pages = reply.pages;
        } else {
          const reply = await askModel(app, config, resolved.system_prompt, resolved.user_prompt, ask);
          values = [{ name: step.variable, type: "text", value: reply.text }];
          pages = reply.pages;
        }
        if (opts.cancelled?.()) return cancelled("Cancelled");
        if (usesWeb(step)) values.push({ name: step.sourcesVariable, type: "text", value: sourceList(pages) });
        const result = produce(ok(resolved), vars, values);
        if (attachments.length) result.note = `Attached ${attachments.map((a) => a.name).join(", ")}`;
        return result;
      } catch (e) {
        return failed(`${config.name}: ${errorMessage(e)}`, resolved);
      }
    }
    case "fetch_page": {
      // Without a page, the text goes on as the page with an empty title, unless the step says to
      // stop. A real run only mentions a failed fetch, since text without a link is normal.
      const asText = (note: string | undefined) => {
        const result = produce(ok(resolved), vars, [
          { name: step.variable, type: "text", value: resolved.url },
          { name: step.titleVariable, type: "text", value: "" },
        ]);
        result.note = note;
        return result;
      };
      const url = findUrl(resolved.url);
      if (!url) {
        if (step.noUrl === "fail") return failed("No URL in the value", resolved);
        return asText(write ? undefined : "No URL, so the text was used as the page");
      }
      try {
        const page = await fetchPage(url);
        return produce(ok(resolved), vars, [
          { name: step.variable, type: "text", value: page.markdown },
          { name: step.titleVariable, type: "text", value: page.title },
        ]);
      } catch (e) {
        const message = errorMessage(e);
        if (step.noUrl === "fail") return failed(`${url}: ${message}`, resolved);
        return asText(`Couldn't fetch ${url} (${message}), so the text was used as the page`);
      }
    }
    case "set_value":
      return produce(ok(resolved), vars, [{ name: step.variable, type: "text", value: resolved.value }]);
    case "stop":
      return { ...ok(resolved), status: "stopped", note: resolved.message || (write ? undefined : "The action stops here") };
    // runAction runs an If block itself and never reaches its markers.
    case "if":
    case "else_if":
    case "else":
    case "end_if":
      return ok(resolved);
    case "create_file": {
      const result = produce(ok(resolved), vars, [{ name: step.variable, type: "file", value: resolved.path }]);
      if (app.vault.getAbstractFileByPath(resolved.path)) {
        result.note = `File already exists: ${resolved.path}`;
        return result;
      }
      return Object.assign(result, await ctx.writer.create(resolved.path, resolved.content));
    }
    case "insert_in_section":
      return insertStep(ctx, step, resolved);
    case "open_file":
      return Object.assign(ok(resolved), await ctx.writer.open(resolved.target, step.openIn, resolved.section));
  }
}

async function insertStep(ctx: StepContext, step: Extract<Step, { type: "insert_in_section" }>, resolved: Record<string, string>): Promise<StepResult> {
  const { app } = ctx;
  const { target, section, format, templatePath } = resolved;
  const existing = app.vault.getAbstractFileByPath(target);
  if (existing && !(existing instanceof TFile)) return failed(`Not a file: ${target}`, resolved);
  if (existing instanceof TFile) return Object.assign(ok(resolved), await ctx.writer.insert(existing, section, step.position, format));

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
  return Object.assign(result, await ctx.writer.create(target, applySplice(initial, insertEdit(spot, format))));
}

// Puts the cursor on the line under a heading, found in the editor's own text so a note created a
// moment ago works before the metadata cache has read it.
function placeCursorUnder(view: MarkdownView, section: string): void {
  const editor = view.editor;
  const line = findHeadingLine(editor.getValue().split("\n"), section);
  if (line === -1) return;
  const target = Math.min(line + 1, editor.lastLine());
  editor.setCursor({ line: target, ch: 0 });
  editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: target, ch: 0 } }, true);
  editor.focus();
}
