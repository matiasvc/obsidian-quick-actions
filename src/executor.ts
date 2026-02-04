import { App, Notice, TFile } from "obsidian";
import { Action, Step } from "./types";
import { openPromptModal, openFilePickerModal } from "./modals";

declare const window: Window & { moment: typeof import("moment") };

function ensureExtension(path: string): string {
	const basename = path.split("/").pop() ?? path;
	if (!basename.includes(".")) return path + ".md";
	return path;
}

export function resolveTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
		return vars[name] !== undefined ? vars[name] : match;
	});
}

function getBuiltinVars(): Record<string, string> {
	const now = window.moment();
	return {
		date: now.format("YYYY-MM-DD"),
		time: now.format("HH:mm"),
		timestamp: now.format("YYYYMMDDHHmmss"),
	};
}

export async function executeAction(app: App, action: Action): Promise<void> {
	const vars = getBuiltinVars();

	for (const step of action.steps) {
		const cancelled = await executeStep(app, step, vars);
		if (cancelled) return;
	}
}

// Returns true if the action should be cancelled
async function executeStep(app: App, step: Step, vars: Record<string, string>): Promise<boolean> {
	switch (step.type) {
		case "prompt": {
			const result = await openPromptModal(app, step.label);
			if (result === null) return true;
			vars[step.variable] = result;
			return false;
		}
		case "file_picker": {
			const folder = resolveTemplate(step.folder, vars);
			const result = await openFilePickerModal(app, folder);
			if (result === null) {
				new Notice("No files found or selection cancelled");
				return true;
			}
			vars[step.variable] = result;
			return false;
		}
		case "tasks_modal": {
			const tasksPlugin = (app as any).plugins?.plugins?.["obsidian-tasks-plugin"];
			if (!tasksPlugin?.apiV1?.createTaskLineModal) {
				new Notice("Tasks plugin not available");
				return true;
			}
			const taskLine = await tasksPlugin.apiV1.createTaskLineModal();
			if (!taskLine) return true;
			vars[step.variable] = taskLine;
			return false;
		}
		case "insert_in_section": {
			const target = resolveTemplate(step.target, vars);
			const section = resolveTemplate(step.section, vars);
			const text = resolveTemplate(step.format, vars);
			const templatePath = resolveTemplate(step.templatePath, vars);
			await insertInSection(app, target, section, step.position, text, step.createIfMissing, templatePath);
			return false;
		}
		case "create_file": {
			let path = resolveTemplate(step.path, vars);
			path = ensureExtension(path);
			const content = resolveTemplate(step.content, vars);
			const existing = app.vault.getAbstractFileByPath(path);
			if (existing) {
				new Notice(`File already exists: ${path}`);
				return false;
			}
			await app.vault.create(path, content);
			new Notice(`Created ${path}`);
			return false;
		}
	}
}

async function insertInSection(
	app: App,
	targetPath: string,
	section: string,
	position: "beginning" | "end",
	text: string,
	createIfMissing: boolean,
	templatePath: string,
): Promise<void> {
	targetPath = ensureExtension(targetPath);
	let file = app.vault.getAbstractFileByPath(targetPath);

	// Create file from template if missing
	if (!file && createIfMissing) {
		try {
			if (templatePath) {
				templatePath = ensureExtension(templatePath);
				const templateFile = app.vault.getAbstractFileByPath(templatePath);
				if (templateFile && templateFile instanceof TFile) {
					const templateContent = await app.vault.read(templateFile);
					file = await app.vault.create(targetPath, templateContent);
				} else {
					new Notice(`Template not found: ${templatePath}`);
					return;
				}
			} else {
				file = await app.vault.create(targetPath, section + "\n");
			}
		} catch (e) {
			new Notice(`Failed to create file: ${e}`);
			return;
		}
	}

	if (!file || !(file instanceof TFile)) {
		new Notice(`File not found: ${targetPath}`);
		return;
	}

	const content = await app.vault.read(file);
	const lines = content.split("\n");

	// Find the section heading
	const sectionLevel = section.match(/^(#+)/)?.[1].length ?? 1;
	let sectionIndex = -1;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trimEnd() === section) {
			sectionIndex = i;
			break;
		}
	}

	if (sectionIndex === -1) {
		new Notice(`Section "${section}" not found in ${targetPath}`);
		return;
	}

	let insertIndex: number;

	if (position === "beginning") {
		// Insert right after the heading line
		insertIndex = sectionIndex + 1;
	} else {
		// Insert at end of section: before next same-or-higher-level heading, or end of file
		insertIndex = lines.length;
		for (let i = sectionIndex + 1; i < lines.length; i++) {
			const headingMatch = lines[i].match(/^(#+)\s/);
			if (headingMatch && headingMatch[1].length <= sectionLevel) {
				insertIndex = i;
				break;
			}
		}
		// Skip blank lines backwards so entry sits right after section content
		while (insertIndex > sectionIndex + 1 && lines[insertIndex - 1].trim() === "") {
			insertIndex--;
		}
	}

	lines.splice(insertIndex, 0, text);
	await app.vault.modify(file, lines.join("\n"));
	new Notice(`Updated ${file.basename}`);
}
