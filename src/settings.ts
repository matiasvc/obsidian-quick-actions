import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { Action, LLMStep, ModelConfig, generateId, makeAction } from "./types";
import { uniqueName } from "./variables";
import QuickActionsPlugin from "./main";
import { STARTERS } from "./starters";
import { providerLabel } from "./providers";
import { UNDO_NOTICE_MS, chainEl, copyUri, emptyEl, linkNotice, plural, textButton } from "./ui";
import { showRowMenu } from "./menus";
import { enableDragReorder, moveItem } from "./dragreorder";
import { ModelEditModal } from "./model-editor";
import { ActionEditModal } from "./editor";

// The whole row opens its editor, which is how a phone edits, and the pencil button does the same
// on a desktop. The other buttons and the grip keep their own jobs.
function openOnClick(row: Setting, open: () => void): void {
  row.settingEl.addEventListener("click", (evt) => {
    if (evt.target instanceof HTMLElement && evt.target.closest(".clickable-icon, .extra-setting-button, .quick-actions-grip")) return;
    open();
  });
  row.addExtraButton((b) => {
    b.setIcon("pencil").setTooltip("Edit").onClick(open);
    b.extraSettingsEl.addClass("quick-actions-edit-button");
  });
}

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
      .setDesc("Each action is a chain of steps and runs from the palette, a hotkey, the ribbon, the launcher or its URI.")
      .addButton((b) => {
        b.setButtonText("Add action").onClick(() => this.editAction(makeAction("New action")));
        if (actions.length === 0) b.setCta();
      });

    const list = containerEl.createDiv();
    actions.forEach((action, i) => this.actionRow(list, action, i));
    if (actions.length === 0) {
      const row = emptyEl(
        containerEl,
        "No actions yet",
        "An action asks you for something, can hand it to a model, and writes the result into your vault. Start from scratch, or from one of these and change what you like.",
      );
      for (const starter of STARTERS) {
        textButton(row, starter.icon, starter.title, () => this.editAction(starter.make())).setAttr("aria-label", starter.desc);
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
        b.setButtonText("Add model").onClick(() => this.editModel({ name: "", provider: "anthropic", model: "", secret_id: "" })),
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
    chainEl(row.descEl, action.steps, { app: this.app, models });
    openOnClick(row, () => this.editAction(action));
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
    row.descEl.appendText(`${providerLabel(model.provider)} · ${model.model || "no model ID"} · key `);
    row.descEl.createSpan({ cls: "quick-actions-var", text: model.secret_id || "none" });
    openOnClick(row, () => this.editModel(model));
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
                  models.splice(index + 1, 0, { ...model, name: uniqueName(`${model.name} copy`, models.map((m) => m.name)) });
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
            onDelete: () => {
              const users = this.stepsUsing(model.name).length;
              this.deleteItem(models, index, `Deleted "${model.name}"${users ? `. ${plural(users, "step uses it and stops until it gets", "steps use it and stop until they get")} another model` : ""}`);
            },
          }),
        ),
    );
  }

  // Opens the editor on a draft of `source`. A new item, one not in the list yet, is only stored on Save.
  private editAction(source: Action): void {
    const existing = this.plugin.settings.actions.includes(source) ? source : null;
    new ActionEditModal(this.app, this.plugin, source, (result) => {
      if (existing) Object.assign(existing, result);
      else this.plugin.settings.actions.push(result);
      this.save();
    }).open();
  }

  // A renamed model takes its steps along, so none of them stops on a missing model.
  private editModel(source: ModelConfig): void {
    const existing = this.plugin.settings.models.includes(source) ? source : null;
    const others = this.plugin.settings.models.filter((m) => m !== existing);
    new ModelEditModal(this.app, source, existing === null, others, (result) => {
      if (existing) {
        const users = existing.name !== result.name ? this.stepsUsing(existing.name) : [];
        for (const step of users) step.model = result.name;
        if (users.length) new Notice(`Renamed ${existing.name} to ${result.name} in ${plural(users.length, "step", "steps")}`);
        Object.assign(existing, result);
      } else {
        this.plugin.settings.models.push(result);
      }
      this.save();
    }).open();
  }

  private stepsUsing(modelName: string): LLMStep[] {
    return this.plugin.settings.actions.flatMap((a) => a.steps.filter((s): s is LLMStep => s.type === "llm" && s.model === modelName));
  }

  private deleteItem<T>(list: T[], index: number, message: string): void {
    const [removed] = list.splice(index, 1);
    this.save();
    linkNotice(
      [message],
      [
        {
          text: "Undo",
          click: () => {
            list.splice(Math.min(index, list.length), 0, removed);
            this.save();
          },
        },
      ],
      UNDO_NOTICE_MS,
    );
  }

  private save(): void {
    void this.plugin.saveSettings().then(() => this.display());
  }
}
