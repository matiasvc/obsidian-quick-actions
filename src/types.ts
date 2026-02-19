// Step type discriminated union

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
}

export type Step = PromptStep | FilePickerStep | TasksModalStep | InsertInSectionStep | CreateFileStep | ChoiceStep | OpenFileStep | LLMStep;

export type StepType = Step["type"];

export const STEP_TYPE_LABELS: Record<StepType, string> = {
	prompt: "Prompt",
	file_picker: "File Picker",
	tasks_modal: "Tasks Modal",
	insert_in_section: "Insert in Section",
	create_file: "Create File",
	choice: "Choice",
	open_file: "Open File",
	llm: "LLM",
};

export interface Action {
	id: string;
	name: string;
	steps: Step[];
}

export interface LLMSettings {
	provider: "openai" | "anthropic";
	model: string;
	secret_id: string;
}

export interface QuickActionsSettings {
	actions: Action[];
	llm: LLMSettings;
}

// Factory functions for default steps

export function defaultPromptStep(): PromptStep {
	return { type: "prompt", variable: "input", label: "Input:", multiline: false };
}

export function defaultFilePickerStep(): FilePickerStep {
	return { type: "file_picker", variable: "file", folder: "" };
}

export function defaultTasksModalStep(): TasksModalStep {
	return { type: "tasks_modal", variable: "task" };
}

export function defaultInsertInSectionStep(): InsertInSectionStep {
	return {
		type: "insert_in_section",
		target: "",
		section: "",
		position: "end",
		format: "",
		createIfMissing: false,
		templatePath: "",
	};
}

export function defaultCreateFileStep(): CreateFileStep {
	return { type: "create_file", path: "", content: "" };
}

export function defaultChoiceStep(): ChoiceStep {
	return { type: "choice", variable: "choice", label: "Choose:", options: [] };
}

export function defaultOpenFileStep(): OpenFileStep {
	return { type: "open_file", target: "", section: "" };
}

export function defaultLLMStep(): LLMStep {
	return { type: "llm", variable: "llm_response", system_prompt: "", user_prompt: "" };
}

export function defaultStepForType(type: StepType): Step {
	switch (type) {
		case "prompt": return defaultPromptStep();
		case "file_picker": return defaultFilePickerStep();
		case "tasks_modal": return defaultTasksModalStep();
		case "insert_in_section": return defaultInsertInSectionStep();
		case "create_file": return defaultCreateFileStep();
		case "choice": return defaultChoiceStep();
		case "open_file": return defaultOpenFileStep();
		case "llm": return defaultLLMStep();
	}
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export const DEFAULT_SETTINGS: QuickActionsSettings = {
	actions: [],
	llm: { provider: "anthropic", model: "claude-sonnet-4-6", secret_id: "" },
};
