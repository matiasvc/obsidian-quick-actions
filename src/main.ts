import { Notice, Plugin } from "obsidian";
import { Action, BranchTest, DEFAULT_ACTION_ICON, LLMOutput, QuickActionsSettings, Step, toSlug } from "./types";
import { STEP_DEFS, newTest, stepWith } from "./steps";
import { repairBlocks } from "./flow";
import { executeAction } from "./executor";
import { ActionPickerModal } from "./modals";
import { QuickActionsSettingTab } from "./settings";

// URI parameters that are not step values.
const URI_KEYS = new Set(["action", "vault", "run"]);

interface Ribbon {
  removeRibbonAction?: (id: string) => void;
}

function normalizeStep(s: Step): Step {
  const step = stepWith(s.type, s);
  if (step.type === "llm") step.outputs = (Array.isArray(step.outputs) ? step.outputs : []).map((o: Partial<LLMOutput>) => ({ name: "", desc: "", choices: [], ...o }));
  if (step.type === "if" || step.type === "else_if") step.tests = (Array.isArray(step.tests) ? step.tests : []).map((t: Partial<BranchTest>) => ({ ...newTest(), ...t }));
  return step;
}

// Fills the missing keys of each step, of a model step's outputs and of a branch's tests with their
// defaults, gives each action an icon, drops steps of unknown types, and makes every If block whole.
function normalize(data: Partial<QuickActionsSettings> | null): QuickActionsSettings {
  const actions: Action[] = (data?.actions ?? []).map((a) => ({
    ...a,
    icon: a.icon || DEFAULT_ACTION_ICON,
    steps: repairBlocks((a.steps ?? []).filter((s: Step) => s && s.type in STEP_DEFS).map(normalizeStep)),
  }));
  return { actions, models: data?.models ?? [] };
}

export default class QuickActionsPlugin extends Plugin {
  settings: QuickActionsSettings;
  private registeredCommandIds: string[] = [];
  private ribbonButtons: { title: string; el: HTMLElement }[] = [];

  async onload() {
    await this.loadSettings();
    this.refreshCommands();
    this.addSettingTab(new QuickActionsSettingTab(this.app, this));

    // One command, so one hotkey or phone toolbar button reaches every action.
    this.addCommand({
      id: "run-action",
      name: "Run a quick action",
      icon: DEFAULT_ACTION_ICON,
      callback: () => new ActionPickerModal(this.app, this.settings.actions, (action) => this.run(action)).open(),
    });

    // obsidian://quick-actions?run=<id or name slug>&<value>=<text>. A value fills the Ask me,
    // Choice or Pick a file step that produces that name, and that step does not ask.
    this.registerObsidianProtocolHandler("quick-actions", (params) => {
      const run = params.run;
      if (!run) {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- plugin name
        new Notice("Quick Actions: missing 'run' parameter");
        return;
      }
      const action = this.settings.actions.find((a) => a.id === run) ?? this.settings.actions.find((a) => toSlug(a.name) === run);
      if (!action) {
        new Notice(`Quick Actions: unknown action "${run}"`);
        return;
      }
      const preset: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) if (!URI_KEYS.has(key) && typeof value === "string") preset[key] = value;
      this.run(action, preset);
    });
  }

  run(action: Action, preset?: Record<string, string>): void {
    void executeAction(this.app, action, this.settings.models, { preset });
  }

  async loadSettings() {
    this.settings = normalize((await this.loadData()) as Partial<QuickActionsSettings> | null);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshCommands();
  }

  refreshCommands() {
    for (const id of this.registeredCommandIds) this.removeCommand(id);
    this.registeredCommandIds = [];
    // The ribbon keeps an entry per button and re-attaches detached buttons on its next change, so
    // each entry is removed the way Obsidian removes a plugin's buttons on unload, and the button
    // is detached now rather than at that next change.
    const ribbon = (this.app.workspace as unknown as { leftRibbon?: Ribbon }).leftRibbon;
    for (const b of this.ribbonButtons) {
      ribbon?.removeRibbonAction?.(`${this.manifest.id}:${b.title}`);
      b.el.detach();
    }
    this.ribbonButtons = [];

    for (const action of this.settings.actions) {
      const commandID = `action-${action.id}`;
      this.addCommand({ id: commandID, name: action.name, icon: action.icon, callback: () => this.run(action) });
      this.registeredCommandIds.push(commandID);
      if (action.ribbon) this.ribbonButtons.push({ title: action.name, el: this.addRibbonIcon(action.icon, action.name, () => this.run(action)) });
    }
  }
}
