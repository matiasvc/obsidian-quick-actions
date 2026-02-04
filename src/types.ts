// Step type discriminated union

export interface PromptStep {
	type: "prompt";
	variable: string;
	label: string;
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

export type Step = PromptStep | FilePickerStep | TasksModalStep | InsertInSectionStep | CreateFileStep;

export type StepType = Step["type"];

export const STEP_TYPE_LABELS: Record<StepType, string> = {
	prompt: "Prompt",
	file_picker: "File Picker",
	tasks_modal: "Tasks Modal",
	insert_in_section: "Insert in Section",
	create_file: "Create File",
};

export interface Action {
	id: string;
	name: string;
	steps: Step[];
}

export interface QuickActionsSettings {
	actions: Action[];
}

// Factory functions for default steps

export function defaultPromptStep(): PromptStep {
	return { type: "prompt", variable: "input", label: "Input:" };
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

export function defaultStepForType(type: StepType): Step {
	switch (type) {
		case "prompt": return defaultPromptStep();
		case "file_picker": return defaultFilePickerStep();
		case "tasks_modal": return defaultTasksModalStep();
		case "insert_in_section": return defaultInsertInSectionStep();
		case "create_file": return defaultCreateFileStep();
	}
}

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export const DEFAULT_SETTINGS: QuickActionsSettings = {
	actions: [],
};
