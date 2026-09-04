// The step table: the one place that knows what each step type is, what it
// produces, and which fields it edits.
import { ModelConfig, OutputType, Step, StepType } from "./types";
import { uniqueName } from "./variables";

export type StepGroup = "ask" | "generate" | "do";

// text: plain input. line/block/file: pill fields (variables allowed; file is a
// single line with a file-typed hint). folder: plain input with folder
// suggestions. options: the reorderable option list.
export type FieldKind = "text" | "line" | "block" | "file" | "folder" | "toggle" | "dropdown" | "options";

export const TEMPLATED_KINDS = new Set<FieldKind>(["line", "block", "file", "folder"]);

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  desc?: string;
  placeholder?: string;
  mono?: boolean;
  options?: { value: string; label: string }[];
  showIf?: (step: Step) => boolean;
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
    fields: [
      { key: "label", label: "Question", kind: "text", desc: "Shown above the input box.", placeholder: "What's on your mind?" },
      { key: "multiline", label: "Multi-line", kind: "toggle", desc: "A larger box. Enter adds a line, Cmd-Enter submits." },
    ],
    make: () => ({ type: "prompt", variable: "input", label: "", multiline: false }),
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
    description: "Choose a note from a folder",
    output: "file",
    defaultOutput: "file",
    outputHint: "the file you pick",
    fields: [
      { key: "folder", label: "Folder", kind: "folder", desc: "Only files in this folder are offered. Empty means the whole vault.", placeholder: "Notes/" },
    ],
    make: () => ({ type: "file_picker", variable: "file", folder: "" }),
  },
  tasks_modal: {
    type: "tasks_modal",
    verb: "Tasks modal",
    icon: "square-check",
    group: "ask",
    description: "Build a task line with the Tasks plugin",
    output: "text",
    defaultOutput: "task",
    outputHint: "the task line",
    fields: [],
    make: () => ({ type: "tasks_modal", variable: "task" }),
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
    fields: [
      { key: "model", label: "Model", kind: "dropdown" },
      { key: "system_prompt", label: "System prompt", kind: "block", placeholder: "How the model should behave." },
      { key: "user_prompt", label: "User prompt", kind: "block", placeholder: "What to send. Type {{ to insert a value." },
    ],
    make: () => ({ type: "llm", variable: "reply", system_prompt: "", user_prompt: "", model: "" }),
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
    fields: [
      { key: "path", label: "Path", kind: "line", desc: ".md is added if missing.", placeholder: "Inbox/{{timestamp}}" },
      { key: "content", label: "Content", kind: "block", mono: true, placeholder: "The note body. Type {{ to insert a value." },
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
    fields: [
      { key: "target", label: "File", kind: "file", desc: "A file from an earlier step, or a path.", placeholder: "Logs/Work" },
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
    fields: [
      { key: "target", label: "File", kind: "file", desc: "A file from an earlier step, or a path.", placeholder: "{{note}}" },
      { key: "section", label: "Scroll to", kind: "line", desc: "A heading in the file. Leave empty for the top.", placeholder: "## Notes" },
    ],
    make: () => ({ type: "open_file", target: "", section: "" }),
  },
};

export const STEP_GROUPS: { id: StepGroup; label: string; types: StepType[] }[] = [
  { id: "ask", label: "Ask", types: ["prompt", "choice", "file_picker", "tasks_modal"] },
  { id: "generate", label: "Generate", types: ["llm"] },
  { id: "do", label: "Do", types: ["create_file", "insert_in_section", "open_file"] },
];

export const STEP_TYPES_IN_ORDER: StepType[] = STEP_GROUPS.flatMap((g) => g.types);

export function makeStep(type: StepType): Step {
  return STEP_DEFS[type].make();
}

export function outputOf(step: Step): { name: string; type: OutputType } | null {
  const def = STEP_DEFS[step.type];
  if (def.output === null || !("variable" in step)) return null;
  return { name: step.variable, type: def.output };
}

// The fields whose values may contain {{variables}}.
export function templatedFields(step: Step): { key: string; value: string }[] {
  const record = step as unknown as Record<string, unknown>;
  const result: { key: string; value: string }[] = [];
  for (const f of STEP_DEFS[step.type].fields) {
    if (!TEMPLATED_KINDS.has(f.kind)) continue;
    const v = record[f.key];
    if (typeof v === "string") result.push({ key: f.key, value: v });
  }
  return result;
}

// Changes a step's type, keeping every same-named field of the same primitive
// type. A colliding output name is uniquified against `taken`.
export function convertStep(step: Step, type: StepType, taken: Iterable<string>): Step {
  const next = makeStep(type) as unknown as Record<string, unknown>;
  const prev = step as unknown as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (key === "type" || key === "variable" || !(key in prev)) continue;
    if (typeof prev[key] === typeof next[key] && Array.isArray(prev[key]) === Array.isArray(next[key])) next[key] = prev[key];
  }
  if ("variable" in next) {
    const wanted = typeof prev.variable === "string" ? prev.variable : STEP_DEFS[type].defaultOutput;
    next.variable = uniqueName(wanted, taken);
  }
  return next as unknown as Step;
}

export function stepTitle(step: Step, models: ModelConfig[]): string {
  if (step.type === "llm") {
    const model = step.model ? models.find((m) => m.name === step.model) : models[0];
    if (model) return model.name;
  }
  return STEP_DEFS[step.type].verb;
}

