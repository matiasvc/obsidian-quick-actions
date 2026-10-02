// The step table: the one place that knows what each step type is, what it
// produces, and which fields it edits.
import { BranchTest, LLMStep, ModelConfig, OutputType, Step, StepType } from "./types";
import { parseRefs, uniqueName } from "./variables";
import { TEST_OPS } from "./flow";

export type StepGroup = "ask" | "generate" | "do" | "flow";

// How many searches or page reads a model step may make for one reply.
export const WEB_MAX_USES = 5;

// text: plain input. line/block/file: pill fields (variables allowed, and file is a
// single line with a file-typed hint). folder: plain input with folder
// suggestions. options: the reorderable option list. outputs: the fields of a
// structured model reply. model: the configured models.
export type FieldKind = "text" | "line" | "block" | "file" | "folder" | "toggle" | "dropdown" | "options" | "outputs" | "model";

export const TEMPLATED_KINDS = new Set<FieldKind>(["line", "block", "file", "folder"]);

// How a templated field's values are finished. A path is cleaned for file names and normalized,
// a note escapes its frontmatter values, and plain takes values as they are.
export type ResolveMode = "plain" | "path" | "note";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  desc?: string;
  placeholder?: string;
  mono?: boolean;
  resolve?: ResolveMode; // plain when omitted
  options?: { value: string; label: string }[];
  showIf?: (step: Step) => boolean;
  unavailable?: (step: Step, models: ModelConfig[]) => string | undefined; // why the control is off
}

export interface StepDef {
  type: StepType;
  verb: string;
  icon: string;
  group: StepGroup;
  description: string;
  output: OutputType | null;
  defaultOutput: string;
  outputHint: string;
  cleanInPath: boolean; // its output is typed or generated text, which a path cleans
  fromUri: boolean; // a URI value for its output replaces asking
  activity?: string; // what the progress notice says while it runs on its own
  preview?: { verb: string; key: string }; // what a test run says it would do, and to which field
  fields: FieldDef[];
  make: () => Step;
}

export const STEP_DEFS: Record<StepType, StepDef> = {
  prompt: {
    type: "prompt",
    verb: "Ask me",
    icon: "text-cursor-input",
    group: "ask",
    description: "A question with a text box",
    output: "text",
    defaultOutput: "input",
    outputHint: "what you typed",
    cleanInPath: true,
    fromUri: true,
    fields: [
      { key: "label", label: "Question", kind: "text", desc: "Shown above the input box.", placeholder: "What's on your mind?" },
      { key: "default", label: "Default", kind: "line", desc: "Already in the box when it opens. {{selection}} starts from the text you selected.", placeholder: "{{selection}}" },
      { key: "multiline", label: "Multi-line", kind: "toggle", desc: "A larger box where Enter adds a line." },
    ],
    make: () => ({ type: "prompt", variable: "input", label: "", multiline: false, default: "" }),
  },
  choice: {
    type: "choice",
    verb: "Choice",
    icon: "list",
    group: "ask",
    description: "Pick one option from a list",
    output: "text",
    defaultOutput: "choice",
    outputHint: "the option you picked",
    cleanInPath: false,
    fromUri: true,
    fields: [
      { key: "label", label: "Question", kind: "text", desc: "Shown above the list.", placeholder: "Which one?" },
      { key: "options", label: "Options", kind: "options" },
    ],
    make: () => ({ type: "choice", variable: "choice", label: "", options: [] }),
  },
  file_picker: {
    type: "file_picker",
    verb: "Pick a file",
    icon: "file",
    group: "ask",
    description: "Choose a note or file from a folder",
    output: "file",
    defaultOutput: "file",
    outputHint: "the file you pick",
    cleanInPath: false,
    fromUri: true,
    fields: [
      { key: "label", label: "Question", kind: "text", desc: "Shown in the search box.", placeholder: "Which log?" },
      { key: "folder", label: "Folder", kind: "folder", desc: "Only files in this folder are offered. Empty means the whole vault.", placeholder: "Notes/" },
      {
        key: "files",
        label: "Files",
        kind: "dropdown",
        options: [
          { value: "notes", label: "Notes" },
          { value: "media", label: "Images and PDFs" },
          { value: "any", label: "Any file" },
        ],
      },
    ],
    make: () => ({ type: "file_picker", variable: "file", label: "", folder: "", files: "notes" }),
  },
  quick_task: {
    type: "quick_task",
    verb: "Quick task",
    icon: "list-checks",
    group: "ask",
    description: "Type a task in the Quick Tasks box, get its note",
    output: "file",
    defaultOutput: "task",
    outputHint: "the task note",
    cleanInPath: false,
    fromUri: false,
    fields: [
      {
        key: "project",
        label: "Project",
        kind: "file",
        desc: "The note Quick Tasks embeds the task in. A note from an earlier step, or a path. Leave empty for none.",
        placeholder: "{{file}}",
      },
      { key: "prefill", label: "Prefill", kind: "line", desc: "Typed into the box before you start, so a tag or a date is already there.", placeholder: "#work" },
    ],
    make: () => ({ type: "quick_task", variable: "task", project: "", prefill: "" }),
  },
  llm: {
    type: "llm",
    verb: "Ask a model",
    icon: "sparkles",
    group: "generate",
    description: "Send a prompt to an LLM, keep the reply",
    output: "text",
    defaultOutput: "reply",
    outputHint: "the reply",
    cleanInPath: true,
    fromUri: false,
    fields: [
      { key: "model", label: "Model", kind: "model" },
      {
        key: "effort",
        label: "Effort",
        kind: "dropdown",
        desc: "How much the model thinks before it answers. Low is faster and cheaper. High and Max are more thorough.",
        options: [
          { value: "", label: "Model default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
        unavailable: (step, models) => {
          const config = modelOf(step, models);
          return config?.provider === "anthropic" && /haiku/i.test(config.model) ? "Haiku models have no effort setting." : undefined;
        },
      },
      { key: "system_prompt", label: "System prompt", kind: "block", placeholder: "How the model should behave." },
      { key: "user_prompt", label: "User prompt", kind: "block", placeholder: "What to send. Type {{ to insert a value." },
      {
        key: "attach",
        label: "Attach",
        kind: "file",
        desc: "Images and PDFs sent with the prompt: a file from an earlier step or a path, several separated by commas. A note sends the images and PDFs it embeds.",
        placeholder: "{{file}}",
      },
      {
        key: "webSearch",
        label: "Search the web",
        kind: "toggle",
        desc: `Up to ${WEB_MAX_USES} searches, about a cent each. The pages it draws on become their own value.`,
      },
      {
        key: "webFetch",
        label: "Read linked pages",
        kind: "toggle",
        desc: `Opens up to ${WEB_MAX_USES} URLs that appear in the user prompt. The pages become their own value.`,
        unavailable: (step, models) => (modelOf(step, models)?.provider === "openai" ? "OpenAI models can't open a given URL. Their web search opens the pages it finds." : undefined),
      },
      { key: "outputs", label: "Reply", kind: "outputs" },
    ],
    make: () => ({ type: "llm", variable: "reply", system_prompt: "", user_prompt: "", attach: "", model: "", effort: "", outputs: [], webSearch: false, webFetch: false, sourcesVariable: "sources" }),
  },
  fetch_page: {
    type: "fetch_page",
    verb: "Fetch page",
    icon: "globe",
    group: "generate",
    description: "Download a web page as Markdown",
    output: "text",
    defaultOutput: "page",
    outputHint: "the page as Markdown, and its title",
    cleanInPath: true,
    fromUri: false,
    activity: "Fetching the page",
    fields: [
      { key: "url", label: "URL", kind: "line", desc: "A URL, or a value with one in it. The first URL is used.", placeholder: "{{source}}" },
      {
        key: "noUrl",
        label: "When there is no page",
        kind: "dropdown",
        desc: "No URL in the value, or the fetch failed.",
        options: [
          { value: "text", label: "Use the text as the page" },
          { value: "fail", label: "Stop the action" },
        ],
      },
    ],
    make: () => ({ type: "fetch_page", variable: "page", titleVariable: "page_title", url: "", noUrl: "text" }),
  },
  create_file: {
    type: "create_file",
    verb: "Create file",
    icon: "file-plus",
    group: "do",
    description: "Write a new note from a template",
    output: "file",
    defaultOutput: "note",
    outputHint: "the file this step creates",
    cleanInPath: false,
    fromUri: false,
    activity: "Creating the note",
    preview: { verb: "Would create", key: "path" },
    fields: [
      {
        key: "path",
        label: "Path",
        kind: "line",
        resolve: "path",
        desc: ".md is added if missing. Missing folders are created. Typed and generated values are made safe for a file name.",
        placeholder: "Inbox/{{timestamp}}",
      },
      { key: "content", label: "Content", kind: "block", mono: true, resolve: "note", placeholder: "The note body. Type {{ to insert a value." },
    ],
    make: () => ({ type: "create_file", variable: "note", path: "", content: "" }),
  },
  insert_in_section: {
    type: "insert_in_section",
    verb: "Insert in section",
    icon: "between-horizontal-start",
    group: "do",
    description: "Add text under a heading in a note",
    output: null,
    defaultOutput: "",
    outputHint: "nothing · this step writes to the file",
    cleanInPath: false,
    fromUri: false,
    activity: "Adding the text",
    preview: { verb: "Would insert into", key: "target" },
    fields: [
      { key: "target", label: "File", kind: "file", resolve: "path", desc: "A file from an earlier step, or a path.", placeholder: "Logs/Work" },
      { key: "section", label: "Section", kind: "line", desc: "The heading line, including the # marks.", placeholder: "# Log" },
      {
        key: "position",
        label: "Position",
        kind: "dropdown",
        options: [
          { value: "end", label: "End of section" },
          { value: "beginning", label: "Start of section" },
        ],
      },
      { key: "format", label: "Text", kind: "block", placeholder: "- {{date}} {{entry}}" },
      { key: "createIfMissing", label: "Create the file if missing", kind: "toggle" },
      {
        key: "templatePath",
        label: "Template",
        kind: "file",
        resolve: "path",
        desc: "Copied into the new file before inserting.",
        placeholder: "Templates/log",
        showIf: (s) => s.type === "insert_in_section" && s.createIfMissing,
      },
    ],
    make: () => ({ type: "insert_in_section", target: "", section: "", position: "end", format: "", createIfMissing: false, templatePath: "" }),
  },
  open_file: {
    type: "open_file",
    verb: "Open file",
    icon: "external-link",
    group: "do",
    description: "Open a note, optionally at a heading",
    output: null,
    defaultOutput: "",
    outputHint: "nothing · this step only opens the file",
    cleanInPath: false,
    fromUri: false,
    activity: "Opening the note",
    preview: { verb: "Would open", key: "target" },
    fields: [
      { key: "target", label: "File", kind: "file", resolve: "path", desc: "A file from an earlier step, or a path.", placeholder: "{{note}}" },
      { key: "section", label: "Scroll to", kind: "line", desc: "A heading in the file. The cursor goes on the line under it.", placeholder: "## Notes" },
      {
        key: "openIn",
        label: "Open in",
        kind: "dropdown",
        options: [
          { value: "current", label: "Current tab" },
          { value: "tab", label: "New tab" },
          { value: "split", label: "Split to the right" },
        ],
      },
    ],
    make: () => ({ type: "open_file", target: "", section: "", openIn: "current" }),
  },
  if: {
    type: "if",
    verb: "If",
    icon: "split",
    group: "flow",
    description: "Run steps only when a value passes a test, with Else if and Else branches",
    output: null,
    defaultOutput: "",
    outputHint: "",
    cleanInPath: false,
    fromUri: false,
    fields: [],
    make: () => ({ type: "if", match: "all", tests: [newTest()] }),
  },
  else_if: {
    type: "else_if",
    verb: "Else if",
    icon: "split",
    group: "flow",
    description: "",
    output: null,
    defaultOutput: "",
    outputHint: "",
    cleanInPath: false,
    fromUri: false,
    fields: [],
    make: () => ({ type: "else_if", match: "all", tests: [newTest()] }),
  },
  else: {
    type: "else",
    verb: "Else",
    icon: "split",
    group: "flow",
    description: "",
    output: null,
    defaultOutput: "",
    outputHint: "",
    cleanInPath: false,
    fromUri: false,
    fields: [],
    make: () => ({ type: "else" }),
  },
  end_if: {
    type: "end_if",
    verb: "End of If",
    icon: "split",
    group: "flow",
    description: "",
    output: null,
    defaultOutput: "",
    outputHint: "",
    cleanInPath: false,
    fromUri: false,
    fields: [],
    make: () => ({ type: "end_if" }),
  },
  set_value: {
    type: "set_value",
    verb: "Set a value",
    icon: "braces",
    group: "flow",
    description: "Turn a template into a named value",
    output: "text",
    defaultOutput: "value",
    outputHint: "the value",
    cleanInPath: true,
    fromUri: false,
    fields: [
      {
        key: "value",
        label: "Value",
        kind: "block",
        desc: "Becomes the value named in the Out band. Other steps may set the same name, and the last one that runs wins.",
        placeholder: "{{page_title}}",
      },
    ],
    make: () => ({ type: "set_value", variable: "value", value: "" }),
  },
  stop: {
    type: "stop",
    verb: "Stop",
    icon: "octagon-x",
    group: "flow",
    description: "End the action here, as finished",
    output: null,
    defaultOutput: "",
    outputHint: "nothing · the action ends here",
    cleanInPath: false,
    fromUri: false,
    fields: [{ key: "message", label: "Message", kind: "line", desc: "Shown when the action stops here. Leave empty for none.", placeholder: "There was no link to fetch" }],
    make: () => ({ type: "stop", message: "" }),
  },
};

export function newTest(): BranchTest {
  return { value: "", op: "filled", text: "" };
}

export const STEP_GROUPS: { id: StepGroup; label: string; types: StepType[] }[] = [
  { id: "ask", label: "Ask", types: ["prompt", "choice", "file_picker", "quick_task"] },
  { id: "generate", label: "Fetch and generate", types: ["fetch_page", "llm"] },
  { id: "do", label: "Do", types: ["create_file", "insert_in_section", "open_file"] },
  { id: "flow", label: "Flow", types: ["if", "set_value", "stop"] },
];

export const STEP_TYPES_IN_ORDER: StepType[] = STEP_GROUPS.flatMap((g) => g.types);

// The types a step can be switched to in place. An If block needs its end, so it is only added.
export const CONVERTIBLE_TYPES: StepType[] = STEP_TYPES_IN_ORDER.filter((t) => t !== "if");

export function makeStep(type: StepType): Step {
  return STEP_DEFS[type].make();
}

// A step of `type` with every default, and `values` on top. For steps written in code.
export function stepWith<T extends StepType>(type: T, values: Partial<Extract<Step, { type: T }>> = {}): Step {
  return { ...makeStep(type), ...values } as Step;
}

export interface StepOutput {
  name: string;
  type: OutputType;
}

// Whether a model step goes on the web, and so hands down its sources.
export function usesWeb(step: LLMStep): boolean {
  return step.webSearch || step.webFetch;
}

// The outputs that make up a model step's reply: one per field, or the whole reply as one.
export function replyOutputs(step: LLMStep): StepOutput[] {
  return step.outputs.length > 0 ? step.outputs.map((o) => ({ name: o.name, type: "text" })) : [{ name: step.variable, type: "text" }];
}

// What a step hands down, in order. A structured model step hands down one value per field, and a
// model step on the web its sources after the reply.
export function outputsOf(step: Step): StepOutput[] {
  if (step.type === "llm") return usesWeb(step) ? [...replyOutputs(step), { name: step.sourcesVariable, type: "text" }] : replyOutputs(step);
  if (step.type === "fetch_page") return [{ name: step.variable, type: "text" }, { name: step.titleVariable, type: "text" }];
  const def = STEP_DEFS[step.type];
  if (def.output === null || !("variable" in step)) return [];
  return [{ name: step.variable, type: def.output }];
}

// What the editor's Out band says a step hands down.
export function outputHintOf(step: Step): string {
  if (step.type !== "llm") return STEP_DEFS[step.type].outputHint;
  return (step.outputs.length > 0 ? "one value per field" : STEP_DEFS.llm.outputHint) + (usesWeb(step) ? ", then its sources" : "");
}

// The step with each field whose control the editor turns off for its model reset to the type's
// default, so a value set for another model is never sent.
export function withoutUnavailable<T extends Step>(step: T, models: ModelConfig[]): T {
  const off = STEP_DEFS[step.type].fields.filter((f) => f.unavailable?.(step, models) !== undefined);
  if (off.length === 0) return step;
  const defaults = makeStep(step.type) as unknown as Record<string, unknown>;
  const copy = { ...step } as unknown as Record<string, unknown>;
  for (const f of off) copy[f.key] = defaults[f.key];
  return copy as unknown as T;
}

// Renames one of a step's outputs in place, without touching its consumers.
export function setOutputName(step: Step, from: string, to: string): void {
  if (step.type === "llm" && usesWeb(step) && step.sourcesVariable === from) {
    step.sourcesVariable = to;
    return;
  }
  if (step.type === "llm" && step.outputs.length > 0) {
    for (const o of step.outputs) if (o.name === from) o.name = to;
    return;
  }
  if (step.type === "fetch_page" && step.titleVariable === from) {
    step.titleVariable = to;
    return;
  }
  if ("variable" in step && step.variable === from) step.variable = to;
}

// Renames the step's outputs in place so none collides with `taken` or with another of its own.
export function freshOutputs(step: Step, taken: Iterable<string>): Step {
  const used = new Set(taken);
  for (const out of outputsOf(step)) {
    const name = uniqueName(out.name, used);
    used.add(name);
    if (name !== out.name) setOutputName(step, out.name, name);
  }
  return step;
}

export interface TemplatedField {
  key: string; // the field's key, which resolveStep's result uses
  value: string;
  mode: ResolveMode;
  set: (value: string) => void;
}

// The fields whose values may contain {{variables}}, each with how its values are finished. A
// branch's tests are fields too, keyed "tests.<n>.value" and "tests.<n>.text".
export function templatedFields(step: Step): TemplatedField[] {
  if (step.type === "if" || step.type === "else_if") {
    return step.tests.flatMap((t, n) => [
      { key: `tests.${n}.value`, value: t.value, mode: "plain" as const, set: (v: string) => (t.value = v) },
      { key: `tests.${n}.text`, value: t.text, mode: "plain" as const, set: (v: string) => (t.text = v) },
    ]);
  }
  const record = step as unknown as Record<string, unknown>;
  const result: TemplatedField[] = [];
  for (const f of STEP_DEFS[step.type].fields) {
    if (!TEMPLATED_KINDS.has(f.kind)) continue;
    const v = record[f.key];
    if (typeof v === "string") result.push({ key: f.key, value: v, mode: f.resolve ?? "plain", set: (value) => (record[f.key] = value) });
  }
  return result;
}

// A branch's tests in a few words, as the rail and the step chain show them: "page_title has
// text", plus "and 1 more" or "or 1 more" when there are several.
export function testsSummary(tests: BranchTest[], match: "all" | "any"): string {
  const first = tests[0];
  if (!first || !first.value.trim()) return "…";
  const whole = first.value.trim();
  const refs = parseRefs(whole);
  const value = refs.length === 1 && refs[0].length === whole.length ? refs[0].name : whole;
  const op = TEST_OPS.find((o) => o.value === first.op);
  const text = op?.needsText ? ` “${first.text}”` : "";
  const more = tests.length > 1 ? ` ${match === "all" ? "and" : "or"} ${tests.length - 1} more` : "";
  return `${value} ${op?.label ?? first.op}${text}${more}`;
}

// Changes a step's type, keeping its name and every same-named field of the same
// primitive type. Colliding output names are uniquified against `taken`.
export function convertStep(step: Step, type: StepType, taken: Iterable<string>): Step {
  const next = makeStep(type) as unknown as Record<string, unknown>;
  const prev = step as unknown as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (key === "type" || key === "titleVariable" || key === "outputs" || !(key in prev)) continue;
    if (typeof prev[key] === typeof next[key] && Array.isArray(prev[key]) === Array.isArray(next[key])) next[key] = prev[key];
  }
  if (typeof prev.name === "string" && prev.name) next.name = prev.name;
  return freshOutputs(next as unknown as Step, taken);
}

// The model a step will run on: the named one, or the first when it names none. Null when the
// named model is not configured (renamed or deleted), so the step fails instead of switching.
export function modelOf(step: Step, models: ModelConfig[]): ModelConfig | null {
  if (step.type !== "llm") return null;
  if (!step.model) return models[0] ?? null;
  return models.find((m) => m.name === step.model) ?? null;
}

export function isModelMissing(step: Step, models: ModelConfig[]): step is LLMStep {
  return step.type === "llm" && modelOf(step, models) === null;
}

// A step's title in the rail and the settings chain: its name, else its model, its first test
// for a branch, or its verb.
export function stepTitle(step: Step, models: ModelConfig[]): string {
  if (step.name?.trim()) return step.name.trim();
  if (step.type === "llm") return modelOf(step, models)?.name ?? (step.model || "Ask a model");
  if (step.type === "if" || step.type === "else_if") return `${STEP_DEFS[step.type].verb} ${testsSummary(step.tests, step.match)}`;
  return STEP_DEFS[step.type].verb;
}

// A step in running text ("used by Classify, Opus → body"). An unnamed model step names its model
// and what it produces, since several model steps would otherwise read alike.
export function stepLabel(step: Step, models: ModelConfig[]): string {
  if (step.name?.trim() || step.type !== "llm") return stepTitle(step, models);
  return `${stepTitle(step, models)} → ${outputsOf(step).map((o) => o.name).join(", ")}`;
}
