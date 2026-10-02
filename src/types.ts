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

export interface FilePickerStep extends StepBase {
  type: "file_picker";
  variable: string;
  label: string;
  folder: string;
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

export interface LLMStep extends StepBase {
  type: "llm";
  variable: string; // the whole reply, when `outputs` is empty
  system_prompt: string;
  user_prompt: string;
  model: string;
  outputs: LLMOutput[];
}

export interface FetchPageStep extends StepBase {
  type: "fetch_page";
  variable: string; // the page as Markdown
  titleVariable: string;
  url: string; // templated: a URL, or text with one in it
  noUrl: "text" | "fail";
}

export type Step = PromptStep | FilePickerStep | QuickTaskStep | InsertInSectionStep | CreateFileStep | ChoiceStep | OpenFileStep | LLMStep | FetchPageStep;

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
