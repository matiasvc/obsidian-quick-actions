import { Notice, Plugin } from "obsidian";
import { QuickActionsSettings, toSlug } from "./types";
import { executeAction } from "./executor";
import { QuickActionsSettingTab } from "./settings";

export default class QuickActionsPlugin extends Plugin {
  settings: QuickActionsSettings;
  private registeredCommandIds: string[] = [];

  async onload() {
    await this.loadSettings();
    this.refreshCommands();
    this.addSettingTab(new QuickActionsSettingTab(this.app, this));

    this.registerObsidianProtocolHandler("quick-actions", (params) => {
      const actionSlug = params.run;
      if (!actionSlug) {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- plugin name
        new Notice("Quick Actions: missing 'run' parameter");
        return;
      }
      const action = this.settings.actions.find(
        (a) => toSlug(a.name) === actionSlug
      );
      if (!action) {
        new Notice(`Quick Actions: unknown action "${actionSlug}"`);
        return;
      }
      executeAction(this.app, action, this.settings.models);
    });
  }

  async loadSettings() {
    this.settings = { actions: [], models: [], ...((await this.loadData()) as Partial<QuickActionsSettings> | null) };
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
      const commandID = `action-${action.id}`;
      this.addCommand({
        id: commandID,
        name: action.name,
        callback: () => executeAction(this.app, action, this.settings.models),
      });
      this.registeredCommandIds.push(commandID);
    }
  }
}
