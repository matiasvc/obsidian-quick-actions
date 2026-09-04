// Step type discriminated union. Every JSON key here is persisted in data.json.

export interface PromptStep {
  type: "prompt";
  variable: string;
  label: string;
  multiline: boolean;
}

export interface FilePickerStep {
  type: "file_picker";
  variable: string;
  folder: string;
}

export interface TasksModalStep {
  type: "tasks_modal";
  variable: string;
}

export interface InsertInSectionStep {
  type: "insert_in_section";
  target: string;
  section: string;
  position: "beginning" | "end";
  format: string;
  createIfMissing: boolean;
  templatePath: string;
}

export interface CreateFileStep {
  type: "create_file";
  variable: string;
  path: string;
  content: string;
}

export interface ChoiceStep {
  type: "choice";
  variable: string;
  label: string;
  options: string[];
}

export interface OpenFileStep {
  type: "open_file";
  target: string;
  section: string;
}

export interface LLMStep {
  type: "llm";
  variable: string;
  system_prompt: string;
  user_prompt: string;
  model: string;
}

export type Step = PromptStep | FilePickerStep | TasksModalStep | InsertInSectionStep | CreateFileStep | ChoiceStep | OpenFileStep | LLMStep;

export type StepType = Step["type"];

export type ProducingStep = Extract<Step, { variable: string }>;

export type OutputType = "text" | "file";

export interface Action {
  id: string;
  name: string;
  steps: Step[];
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

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/ /g, "-");
}
