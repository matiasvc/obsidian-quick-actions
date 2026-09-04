import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { Action, ModelConfig, generateId } from "./types";
import QuickActionsPlugin from "./main";
import { STARTERS } from "./starters";
import { providerLabel } from "./llm";
import { chainEl, copyUri, emptyEl, textButton } from "./ui";
import { showRowMenu } from "./menus";
import { enableDragReorder, moveItem } from "./dragreorder";
import { ModelEditModal } from "./model-editor";
import { ActionEditModal } from "./editor";

const UNDO_NOTICE_MS = 8000;

export class QuickActionsSettingTab extends PluginSettingTab {
  plugin: QuickActionsPlugin;
  private disposeDrag: (() => void) | null = null;

  constructor(app: App, plugin: QuickActionsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const { actions, models } = this.plugin.settings;
    this.disposeDrag?.();
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName("Actions")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- URI is an acronym
      .setDesc("Each action is a chain of steps and runs as a command from the palette, a hotkey, or its URI.")
      .addButton((b) => {
        b.setButtonText("Add action").onClick(() => this.editAction(null, { id: generateId(), name: "New action", steps: [] }));
        if (actions.length === 0) b.setCta();
      });

    const list = containerEl.createDiv();
    actions.forEach((action, i) => this.actionRow(list, action, i));
    if (actions.length === 0) {
      const { row } = emptyEl(
        containerEl,
        "No actions yet",
        "An action asks you for something, can hand it to a model, and writes the result into your vault. Start from scratch, or from one of these and change what you like.",
      );
      for (const starter of STARTERS) {
        textButton(row, starter.icon, starter.title, () => this.editAction(null, starter.make())).setAttr("aria-label", starter.desc);
      }
    }
    this.disposeDrag = enableDragReorder(list, {
      itemSelector: ".quick-actions-row",
      handleSelector: ".quick-actions-grip",
      onReorder: (from, to) => {
        moveItem(actions, from, to);
        this.save();
      },
    });

    new Setting(containerEl)
      .setHeading()
      .setName("Models")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- API and Keychain
      .setDesc("Ask a model steps pick one of these. API keys live in Settings › Keychain and are referenced by name.")
      .addButton((b) =>
        b.setButtonText("Add model").onClick(() => this.editModel(null, { name: "", provider: "anthropic", model: "", secret_id: "" })),
      );
    models.forEach((model, i) => this.modelRow(containerEl, model, i));
    if (models.length === 0) emptyEl(containerEl, null, "No models yet. Only needed for Ask a model steps.");
  }

  hide(): void {
    this.disposeDrag?.();
    this.disposeDrag = null;
  }

  private actionRow(parent: HTMLElement, action: Action, index: number): void {
    const { actions, models } = this.plugin.settings;
    const row = new Setting(parent).setName(action.name || "Untitled action");
    row.settingEl.addClass("quick-actions-row");
    const grip = createDiv("quick-actions-grip");
    setIcon(grip, "grip-vertical");
    row.settingEl.prepend(grip);
    chainEl(row.descEl, action.steps, models);
    row.addExtraButton((b) => b.setIcon("pencil").setTooltip("Edit").onClick(() => this.editAction(action, action)));
    row.addExtraButton((b) =>
      b
        .setIcon("ellipsis-vertical")
        .setTooltip("More")
        .onClick(() =>
          showRowMenu(b.extraSettingsEl, {
            extra: [
              {
                title: "Duplicate",
                icon: "copy",
                click: () => {
                  const copy: Action = { ...JSON.parse(JSON.stringify(action)), id: generateId(), name: `${action.name} copy` };
                  actions.splice(index + 1, 0, copy);
                  this.save();
                },
              },
              { title: "Copy URI", icon: "link", click: () => copyUri(this.app, action) },
            ],
            index,
            count: actions.length,
            onMove: (to) => {
              moveItem(actions, index, to);
              this.save();
            },
            onDelete: () => this.deleteItem(actions, index, `Deleted "${action.name}"`),
          }),
        ),
    );
  }

  private modelRow(parent: HTMLElement, model: ModelConfig, index: number): void {
    const { models } = this.plugin.settings;
    const row = new Setting(parent).setName(model.name || "Unnamed model");
    row.settingEl.addClass("quick-actions-row");
    row.descEl.appendText(`${providerLabel(model.provider)} · ${model.model || "no model id"} · key `);
    row.descEl.createSpan({ cls: "quick-actions-var", text: model.secret_id || "none" });
    row.addExtraButton((b) => b.setIcon("pencil").setTooltip("Edit").onClick(() => this.editModel(model, model)));
    row.addExtraButton((b) =>
      b
        .setIcon("ellipsis-vertical")
        .setTooltip("More")
        .onClick(() =>
          showRowMenu(b.extraSettingsEl, {
            extra: [
              {
                title: "Duplicate",
                icon: "copy",
                click: () => {
                  models.splice(index + 1, 0, { ...model, name: `${model.name} copy` });
                  this.save();
                },
              },
            ],
            index,
            count: models.length,
            onMove: (to) => {
              moveItem(models, index, to);
              this.save();
            },
            onDelete: () => this.deleteItem(models, index, `Deleted "${model.name}"`),
          }),
        ),
    );
  }

  // Opens the editor on a draft. `existing` is null for a new item, which is only stored on Save.
  private editAction(existing: Action | null, source: Action): void {
    new ActionEditModal(this.app, this.plugin, source, (result) => {
      if (existing) Object.assign(existing, result);
      else this.plugin.settings.actions.push(result);
      this.save();
    }).open();
  }

  private editModel(existing: ModelConfig | null, source: ModelConfig): void {
    new ModelEditModal(this.app, source, existing === null, (result) => {
      if (existing) Object.assign(existing, result);
      else this.plugin.settings.models.push(result);
      this.save();
    }).open();
  }

  private deleteItem<T>(list: T[], index: number, message: string): void {
    const [removed] = list.splice(index, 1);
    this.save();
    const notice = new Notice("", UNDO_NOTICE_MS);
    notice.messageEl.setText(`${message}. `);
    const undo = notice.messageEl.createEl("a", { text: "Undo" });
    undo.addEventListener("click", (evt) => {
      evt.preventDefault();
      notice.hide();
      list.splice(Math.min(index, list.length), 0, removed);
      this.save();
    });
  }

  private save(): void {
    void this.plugin.saveSettings().then(() => this.display());
  }
}
