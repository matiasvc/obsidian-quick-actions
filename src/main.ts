import { Plugin } from "obsidian";
import { QuickActionsSettings, DEFAULT_SETTINGS } from "./types";
import { executeAction } from "./executor";
import { QuickActionsSettingTab } from "./settings";

export default class QuickActionsPlugin extends Plugin {
	settings: QuickActionsSettings;
	private registeredCommandIds: string[] = [];

	async onload() {
		await this.loadSettings();
		this.refreshCommands();
		this.addSettingTab(new QuickActionsSettingTab(this.app, this));
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshCommands();
	}

	refreshCommands() {
		// Remove old commands
		for (const id of this.registeredCommandIds) {
			this.removeCommand(id);
		}
		this.registeredCommandIds = [];

		// Register new commands
		for (const action of this.settings.actions) {
			const commandId = `action-${action.id}`;
			this.addCommand({
				id: commandId,
				name: action.name,
				callback: () => executeAction(this.app, action, this.settings.llm),
			});
			this.registeredCommandIds.push(commandId);
		}
	}

	private removeCommand(id: string) {
		// Obsidian doesn't expose removeCommand publicly, use internal API
		const fullId = this.manifest.id + ":" + id;
		(this.app as any).commands?.removeCommand?.(fullId);
	}
}
