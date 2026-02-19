import { AbstractInputSuggest, App, Modal, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import {
	Action,
	ModelConfig,
	Step,
	StepType,
	STEP_TYPE_LABELS,
	QuickActionsSettings,
	defaultStepForType,
	generateId,
} from "./types";
import QuickActionsPlugin from "./main";

class FileSuggest extends AbstractInputSuggest<TFile> {
	getSuggestions(query: string): TFile[] {
		const lower = query.toLowerCase();
		return this.app.vault.getMarkdownFiles()
			.filter((f) => f.path.toLowerCase().contains(lower))
			.slice(0, 20);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		(this as any).textInputEl.value = file.path;
		(this as any).textInputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	getSuggestions(query: string): TFolder[] {
		const lower = query.toLowerCase();
		const folders: TFolder[] = [];
		this.app.vault.getAllLoadedFiles().forEach((f) => {
			if (f instanceof TFolder && f.path.toLowerCase().contains(lower)) {
				folders.push(f);
			}
		});
		folders.sort((a, b) => a.path.localeCompare(b.path));
		return folders.slice(0, 20);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path + "/");
	}

	selectSuggestion(folder: TFolder): void {
		const val = folder.path + "/";
		(this as any).textInputEl.value = val;
		(this as any).textInputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

function stepSummary(steps: Step[]): string {
	return steps.map((s) => STEP_TYPE_LABELS[s.type]).join(" -> ");
}

export class QuickActionsSettingTab extends PluginSettingTab {
	plugin: QuickActionsPlugin;

	constructor(app: App, plugin: QuickActionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Quick Actions" });

		// Models
		containerEl.createEl("h3", { text: "Models" });

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("+ Add Model").onClick(() => {
				const model: ModelConfig = {
					name: "New Model",
					provider: "anthropic",
					model: "",
					secret_id: "",
				};
				this.plugin.settings.models.push(model);
				new ModelEditModal(this.app, this.plugin, model, () => this.display()).open();
			}),
		);

		const models = this.plugin.settings.models;
		for (let i = 0; i < models.length; i++) {
			const model = models[i];
			new Setting(containerEl)
				.setName(model.name || "(unnamed)")
				.setDesc(`${model.provider} / ${model.model || "(no model ID)"}`)
				.addButton((btn) =>
					btn.setButtonText("Edit").onClick(() => {
						new ModelEditModal(this.app, this.plugin, model, () => this.display()).open();
					}),
				)
				.addButton((btn) =>
					btn.setButtonText("Duplicate").onClick(async () => {
						const copy: ModelConfig = { ...model, name: model.name + " (copy)" };
						models.splice(i + 1, 0, copy);
						await this.plugin.saveSettings();
						this.display();
					}),
				)
				.addButton((btn) =>
					btn.setButtonText("Delete").setWarning().onClick(async () => {
						models.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
				);
		}

		// Actions
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("+ New Action").onClick(() => {
				const action: Action = {
					id: generateId(),
					name: "New Action",
					steps: [],
				};
				this.plugin.settings.actions.push(action);
				this.openActionEditor(action);
			}),
		);

		const actions = this.plugin.settings.actions;
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i];
			const setting = new Setting(containerEl)
				.setName(action.name)
				.setDesc(stepSummary(action.steps) || "(no steps)");

			setting.addButton((btn) =>
				btn.setButtonText("Edit").onClick(() => {
					this.openActionEditor(action);
				}),
			);
			setting.addButton((btn) =>
				btn.setButtonText("Duplicate").onClick(async () => {
					const copy: Action = JSON.parse(JSON.stringify(action));
					copy.id = generateId();
					copy.name = action.name + " (copy)";
					actions.splice(i + 1, 0, copy);
					await this.plugin.saveSettings();
					this.display();
				}),
			);
			setting.addButton((btn) =>
				btn.setButtonText("Delete").setWarning().onClick(async () => {
					actions.splice(i, 1);
					await this.plugin.saveSettings();
					this.display();
				}),
			);
			setting.addButton((btn) => {
				btn.setButtonText("\u2191").setTooltip("Move Up");
				if (i > 0) {
					btn.onClick(async () => {
						[actions[i - 1], actions[i]] = [actions[i], actions[i - 1]];
						await this.plugin.saveSettings();
						this.display();
					});
				} else {
					btn.setDisabled(true);
					btn.buttonEl.style.visibility = "hidden";
				}
			});
			setting.addButton((btn) => {
				btn.setButtonText("\u2193").setTooltip("Move Down");
				if (i < actions.length - 1) {
					btn.onClick(async () => {
						[actions[i], actions[i + 1]] = [actions[i + 1], actions[i]];
						await this.plugin.saveSettings();
						this.display();
					});
				} else {
					btn.setDisabled(true);
					btn.buttonEl.style.visibility = "hidden";
				}
			});
		}
	}

	private openActionEditor(action: Action) {
		new ActionEditModal(this.app, this.plugin, action, () => this.display()).open();
	}
}

class ModelEditModal extends Modal {
	private plugin: QuickActionsPlugin;
	private model: ModelConfig;
	private onSaved: () => void;
	private draft: ModelConfig;

	constructor(app: App, plugin: QuickActionsPlugin, model: ModelConfig, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.model = model;
		this.onSaved = onSaved;
		this.draft = { ...model };
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Edit Model" });

		new Setting(contentEl).setName("Name").addText((t) =>
			t.setPlaceholder("e.g. Sonnet, Haiku, GPT-4o")
				.setValue(this.draft.name)
				.onChange((v) => { this.draft.name = v; }),
		);

		new Setting(contentEl).setName("Provider").addDropdown((d) =>
			d.addOption("anthropic", "Anthropic")
				.addOption("openai", "OpenAI")
				.setValue(this.draft.provider)
				.onChange((v) => { this.draft.provider = v as "openai" | "anthropic"; }),
		);

		new Setting(contentEl).setName("Model ID").addText((t) =>
			t.setPlaceholder("e.g. claude-sonnet-4-6")
				.setValue(this.draft.model)
				.onChange((v) => { this.draft.model = v; }),
		);

		new Setting(contentEl)
			.setName("API Key Secret ID")
			.setDesc("Store your API key in Settings > Keychain, then enter the secret ID here.")
			.addText((t) =>
				t.setPlaceholder("e.g. anthropic-api-key")
					.setValue(this.draft.secret_id)
					.onChange((v) => { this.draft.secret_id = v; }),
			);

		const footer = new Setting(contentEl);
		footer.addButton((btn) =>
			btn.setButtonText("Save").setCta().onClick(async () => {
				Object.assign(this.model, this.draft);
				await this.plugin.saveSettings();
				this.onSaved();
				this.close();
			}),
		);
		footer.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				this.close();
			}),
		);
	}
}

class ActionEditModal extends Modal {
	private plugin: QuickActionsPlugin;
	private action: Action;
	private onSaved: () => void;
	// Work on a deep copy so Cancel doesn't persist partial changes
	private draft: Action;

	constructor(app: App, plugin: QuickActionsPlugin, action: Action, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.action = action;
		this.onSaved = onSaved;
		this.draft = JSON.parse(JSON.stringify(action));
	}

	onOpen() {
		this.modalEl.addClass("quick-actions-edit-modal");
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Edit Action" });

		// Action name
		new Setting(contentEl).setName("Name").addText((text) =>
			text.setValue(this.draft.name).onChange((val) => {
				this.draft.name = val;
			}),
		);

		// Steps list
		const stepsContainer = contentEl.createDiv("quick-actions-steps-container");

		for (let i = 0; i < this.draft.steps.length; i++) {
			this.renderStep(stepsContainer, i);
		}

		// Add step button
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("+ Add Step").onClick(() => {
				this.draft.steps.push(defaultStepForType("prompt"));
				this.render();
			}),
		);

		// Save / Cancel
		const footer = new Setting(contentEl);
		footer.addButton((btn) =>
			btn
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					// Copy draft back to real action
					Object.assign(this.action, this.draft);
					await this.plugin.saveSettings();
					this.onSaved();
					this.close();
				}),
		);
		footer.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				this.close();
			}),
		);
	}

	private renderStep(container: HTMLElement, index: number) {
		const step = this.draft.steps[index];
		const stepEl = container.createDiv("quick-actions-step");

		// Header: type dropdown + move/delete buttons
		const header = new Setting(stepEl).setName(`Step ${index + 1}`);

		header.addDropdown((dropdown) => {
			const types: StepType[] = ["prompt", "file_picker", "tasks_modal", "insert_in_section", "create_file", "choice", "open_file", "llm"];
			for (const t of types) {
				dropdown.addOption(t, STEP_TYPE_LABELS[t]);
			}
			dropdown.setValue(step.type);
			dropdown.onChange((val) => {
				if (val !== step.type) {
					this.draft.steps[index] = defaultStepForType(val as StepType);
					this.render();
				}
			});
		});

		if (index > 0) {
			header.addButton((btn) =>
				btn.setButtonText("\u2191").setTooltip("Move Up").onClick(() => {
					[this.draft.steps[index - 1], this.draft.steps[index]] = [this.draft.steps[index], this.draft.steps[index - 1]];
					this.render();
				}),
			);
		}
		if (index < this.draft.steps.length - 1) {
			header.addButton((btn) =>
				btn.setButtonText("\u2193").setTooltip("Move Down").onClick(() => {
					[this.draft.steps[index], this.draft.steps[index + 1]] = [this.draft.steps[index + 1], this.draft.steps[index]];
					this.render();
				}),
			);
		}
		header.addButton((btn) =>
			btn.setButtonText("Delete").setWarning().onClick(() => {
				this.draft.steps.splice(index, 1);
				this.render();
			}),
		);

		// Type-specific fields
		this.renderStepFields(stepEl, index);
	}

	private renderStepFields(container: HTMLElement, index: number) {
		const step = this.draft.steps[index];

		switch (step.type) {
			case "prompt": {
				new Setting(container).setName("Label").addText((t) =>
					t.setValue(step.label).onChange((v) => { step.label = v; }),
				);
				new Setting(container).setName("Variable name").addText((t) =>
					t.setValue(step.variable).onChange((v) => { step.variable = v; }),
				);
				new Setting(container).setName("Multi-line").addToggle((t) =>
					t.setValue(step.multiline).onChange((v) => { step.multiline = v; }),
				);
				break;
			}
			case "file_picker": {
				new Setting(container).setName("Variable name").addText((t) =>
					t.setValue(step.variable).onChange((v) => { step.variable = v; }),
				);
				new Setting(container).setName("Folder").addText((t) => {
					t.setPlaceholder("e.g. Task Lists/").setValue(step.folder).onChange((v) => { step.folder = v; });
					new FolderSuggest(this.app, t.inputEl);
				});
				break;
			}
			case "tasks_modal": {
				new Setting(container).setName("Variable name").addText((t) =>
					t.setValue(step.variable).onChange((v) => { step.variable = v; }),
				);
				break;
			}
			case "insert_in_section": {
				new Setting(container).setName("Target file path").addText((t) =>
					t.setPlaceholder("e.g. {{file}} or Journal/Daily/D-{{date}}.md")
						.setValue(step.target)
						.onChange((v) => { step.target = v; }),
				);
				new Setting(container).setName("Section heading").addText((t) =>
					t.setPlaceholder("e.g. ## Log").setValue(step.section).onChange((v) => { step.section = v; }),
				);
				new Setting(container).setName("Position").addDropdown((d) =>
					d.addOption("beginning", "Beginning").addOption("end", "End")
						.setValue(step.position)
						.onChange((v) => { step.position = v as "beginning" | "end"; }),
				);
				new Setting(container).setName("Format").addText((t) =>
					t.setPlaceholder("e.g. - ({{time}}) {{entry}}")
						.setValue(step.format)
						.onChange((v) => { step.format = v; }),
				);
				new Setting(container).setName("Create file if missing").addToggle((t) =>
					t.setValue(step.createIfMissing).onChange((v) => {
						step.createIfMissing = v;
						this.render();
					}),
				);
				if (step.createIfMissing) {
					new Setting(container).setName("Template path").addText((t) => {
						t.setPlaceholder("e.g. Templates/Journal/daily-note.md")
							.setValue(step.templatePath)
							.onChange((v) => { step.templatePath = v; });
						new FileSuggest(this.app, t.inputEl);
					});
				}
				break;
			}
			case "create_file": {
				new Setting(container).setName("File path").addText((t) =>
					t.setPlaceholder("e.g. Inbox/{{timestamp}} - Fleeting.md")
						.setValue(step.path)
						.onChange((v) => { step.path = v; }),
				);
				new Setting(container).setName("Content").addTextArea((t) =>
					t.setPlaceholder("File content with {{variables}}")
						.setValue(step.content)
						.onChange((v) => { step.content = v; }),
				);
				break;
			}
			case "choice": {
				new Setting(container).setName("Label").addText((t) =>
					t.setValue(step.label).onChange((v) => { step.label = v; }),
				);
				new Setting(container).setName("Variable name").addText((t) =>
					t.setValue(step.variable).onChange((v) => { step.variable = v; }),
				);
				new Setting(container).setName("Options (one per line)").addTextArea((t) =>
					t.setValue(step.options.join("\n")).onChange((v) => {
						step.options = v.split("\n").filter((line) => line.trim() !== "");
					}),
				);
				break;
			}
			case "open_file": {
				new Setting(container).setName("Target file path").addText((t) =>
					t.setPlaceholder("e.g. {{file}} or Journal/Daily/D-{{date}}.md")
						.setValue(step.target)
						.onChange((v) => { step.target = v; }),
				);
				new Setting(container).setName("Section (optional)").addText((t) =>
					t.setPlaceholder("e.g. ## Log")
						.setValue(step.section)
						.onChange((v) => { step.section = v; }),
				);
				break;
			}
			case "llm": {
				const models = this.plugin.settings.models;
				if (models.length === 0) {
					new Setting(container).setName("Model").setDesc("No models configured. Add one in the Models section above.");
				} else {
					new Setting(container).setName("Model").addDropdown((d) => {
						d.addOption("", "(use first model)");
						for (const m of models) {
							d.addOption(m.name, m.name);
						}
						d.setValue(step.model || "");
						d.onChange((v) => { step.model = v; });
					});
				}
				new Setting(container).setName("Variable name").addText((t) =>
					t.setValue(step.variable).onChange((v) => { step.variable = v; }),
				);
				new Setting(container).setName("System prompt").addTextArea((t) =>
					t.setPlaceholder("System prompt with {{variables}}")
						.setValue(step.system_prompt)
						.onChange((v) => { step.system_prompt = v; }),
				);
				new Setting(container).setName("User prompt").addTextArea((t) =>
					t.setPlaceholder("User prompt with {{variables}}")
						.setValue(step.user_prompt)
						.onChange((v) => { step.user_prompt = v; }),
				);
				break;
			}
		}
	}
}
