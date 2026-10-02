// Step type discriminated union. Every JSON key here is persisted in data.json.

// Every step may carry a name, shown in place of its type in the editor and the settings list.
interface StepBase {
  name?: string;
}

export interface PromptStep extends StepBase {
  type: "prompt";
  variable: string;
  label: string;
  multiline: boolean;
  default: string; // templated: already in the box when it opens
}

// Which files Pick a file offers: notes, the images and PDFs a model can take, or every file.
export type FileKind = "notes" | "media" | "any";

export interface FilePickerStep extends StepBase {
  type: "file_picker";
  variable: string;
  label: string;
  folder: string;
  files: FileKind;
}

export interface QuickTaskStep extends StepBase {
  type: "quick_task";
  variable: string;
  project: string; // templated: a note from an earlier step or a path, "" for none
  prefill: string; // templated: text already in the quick-add box
}

export interface InsertInSectionStep extends StepBase {
  type: "insert_in_section";
  target: string;
  section: string;
  position: "beginning" | "end";
  format: string;
  createIfMissing: boolean;
  templatePath: string;
}

export interface CreateFileStep extends StepBase {
  type: "create_file";
  variable: string;
  path: string;
  content: string;
}

export interface ChoiceStep extends StepBase {
  type: "choice";
  variable: string;
  label: string;
  options: string[];
}

export type OpenIn = "current" | "tab" | "split";

export interface OpenFileStep extends StepBase {
  type: "open_file";
  target: string;
  section: string;
  openIn: OpenIn;
}

// One field of a structured reply. `choices` limits it to a fixed list when not empty.
export interface LLMOutput {
  name: string;
  desc: string;
  choices: string[];
}

// How much a model thinks before it answers, in both providers' words.
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMStep extends StepBase {
  type: "llm";
  variable: string; // the whole reply, when `outputs` is empty
  system_prompt: string;
  user_prompt: string;
  attach: string; // templated: images and PDFs, or notes whose embedded ones are sent, separated by commas
  model: string;
  effort: Effort | ""; // "" leaves it to the model
  outputs: LLMOutput[];
  webSearch: boolean;
  webFetch: boolean; // Anthropic only: open URLs that appear in the prompt
  sourcesVariable: string; // the pages the reply drew on, handed down when either web option is on
}

export interface FetchPageStep extends StepBase {
  type: "fetch_page";
  variable: string; // the page as Markdown
  titleVariable: string;
  url: string; // templated: a URL, or text with one in it
  noUrl: "text" | "fail"; // when there is no page: no URL in the value, or the fetch failed
}

// How a branch tests a value. Every op but filled and empty compares it with `text`.
export type TestOp = "filled" | "empty" | "is" | "is_not" | "contains" | "not_contains" | "matches";

export interface BranchTest {
  value: string; // templated
  op: TestOp;
  text: string; // templated
}

// An If block lies flat in the step list: an if, any else_ifs, an optional else, then an end_if.
// The steps between two of them make up a branch.
export interface IfStep extends StepBase {
  type: "if";
  match: "all" | "any";
  tests: BranchTest[];
}

export interface ElseIfStep extends StepBase {
  type: "else_if";
  match: "all" | "any";
  tests: BranchTest[];
}

export interface ElseStep extends StepBase {
  type: "else";
}

export interface EndIfStep extends StepBase {
  type: "end_if";
}

export interface SetValueStep extends StepBase {
  type: "set_value";
  variable: string;
  value: string; // templated
}

export interface StopStep extends StepBase {
  type: "stop";
  message: string; // templated: shown when the action stops here
}

export type Step =
  | PromptStep
  | FilePickerStep
  | QuickTaskStep
  | InsertInSectionStep
  | CreateFileStep
  | ChoiceStep
  | OpenFileStep
  | LLMStep
  | FetchPageStep
  | IfStep
  | ElseIfStep
  | ElseStep
  | EndIfStep
  | SetValueStep
  | StopStep;

export type StepType = Step["type"];

export type OutputType = "text" | "file";

export interface Action {
  id: string;
  name: string;
  steps: Step[];
  icon: string; // an icon id for the command, the launcher and the ribbon
  ribbon?: boolean;
}

export interface ModelConfig {
  name: string;
  provider: "openai" | "anthropic";
  model: string;
  secret_id: string;
  max_tokens?: number; // the most a reply may use, thinking included. Unset means DEFAULT_MAX_TOKENS for Anthropic and no limit for OpenAI
}

// A web page a model reply drew on.
export interface Page {
  url: string;
  title?: string;
}

export interface QuickActionsSettings {
  actions: Action[];
  models: ModelConfig[];
}

export const DEFAULT_ACTION_ICON = "zap";

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function makeAction(name: string, steps: Step[] = []): Action {
  return { id: generateId(), name, steps, icon: DEFAULT_ACTION_ICON };
}

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/ /g, "-");
}
