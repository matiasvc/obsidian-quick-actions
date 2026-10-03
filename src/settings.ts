import { App, Notice, PluginSettingTab, Setting, SettingGroup, prepareSimpleSearch, setIcon } from "obsidian";
import { Action, LLMStep, ModelConfig, actionCommandId, generateId, makeAction } from "./types";
import { uniqueName } from "./variables";
import QuickActionsPlugin from "./main";
import { STARTERS } from "./starters";
import { STEP_DEFS, modelUses, stepTitle } from "./steps";
import { stepCount } from "./flow";
import { modelProblem } from "./providers";
import { actionUses } from "./recent";
import { UNDO_NOTICE_MS, copyUri, flowEl, linkNotice, plural, textButton, usedLabel } from "./ui";
import { showRowMenu } from "./menus";
import { enableDragReorder, moveItem } from "./dragreorder";
import { ModelEditModal } from "./model-editor";
import { ActionEditModal } from "./editor";

// Private parts of Obsidian's hotkey manager and settings modal, which have no public API.
// Obsidian's own plugin lists open a plugin's hotkeys the same way, as the Hotkeys tab searched for it.
interface PrivateApp {
  hotkeyManager?: { printHotkeyForCommand?: (id: string) => string };
  setting?: { openTabById?: (id: string) => { setQuery?: (query: string) => void } | null | undefined };
}

// The command's first hotkey as Obsidian prints it, or "" when it has none.
function hotkeyLabel(app: App, commandId: string): string {
  return (app as unknown as PrivateApp).hotkeyManager?.printHotkeyForCommand?.(commandId) ?? "";
}

function openHotkeys(app: App, query: string): void {
  (app as unknown as PrivateApp).setting?.openTabById?.("hotkeys")?.setQuery?.(query);
}

// The whole row opens its editor. Its buttons, hotkey and grip keep their own jobs. The target
// can be an icon's SVG, which is an Element but not an HTMLElement.
function openOnClick(row: Setting, open: () => void): void {
  row.settingEl.addEventListener("click", (evt) => {
    if (evt.target instanceof Element && evt.target.closest(".clickable-icon, .setting-hotkey, .quick-actions-grip")) return;
    open();
  });
}

// The leading icon, where Obsidian's own list rows keep theirs.
function rowIcon(row: Setting, icon: string, cls?: string): void {
  const el = createDiv(cls ? `setting-item-icon ${cls}` : "setting-item-icon");
  setIcon(el, icon);
  row.settingEl.prepend(el);
}

export class QuickActionsSettingTab extends PluginSettingTab {
  plugin: QuickActionsPlugin;
  private disposeDrag: (() => void) | null = null;
  private query = ""; // the action search, kept across the re-render after each change

  constructor(app: App, plugin: QuickActionsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const { actions, models } = this.plugin.settings;
    this.disposeDrag?.();
    this.disposeDrag = null;
    containerEl.empty();

    const uses = actionUses(this.app);
    const rows: { el: HTMLElement; text: string }[] = [];
    const filter = () => {
      const q = this.query.trim();
      const match = q ? prepareSimpleSearch(q) : null;
      for (const row of rows) row.el.toggle(!match || match(row.text) !== null);
    };
    const newAction = () => this.editAction(makeAction("New action"));

    const actionGroup = new SettingGroup(containerEl)
      .setHeading("Actions")
      .addClass("mod-list")
      .addExtraButton((b) => b.setIcon("plus").setTooltip("New action").onClick(newAction));
    if (actions.length > 0) {
      actionGroup.addSearch((s) =>
        s
          .setPlaceholder("Search actions...")
          .setValue(this.query)
          .onChange((q) => {
            this.query = q;
            filter();
          }),
      );
    }
    actions.forEach((action, i) =>
      actionGroup.addSetting((row) => {
        this.actionRow(row, action, i, uses[action.id]);
        rows.push({ el: row.settingEl, text: [action.name, ...action.steps.map((s) => stepTitle(s, models))].join(" ") });
      }),
    );
    if (actions.length === 0) {
      actionGroup.addSetting((row) => {
        row.setName("No actions yet");
        row.setDesc("An action asks you for something, can hand it to a model, and writes the result into your vault. Start from scratch, or from one of these and change what you like.");
        row.settingEl.addClass("mod-empty-state");
        const buttons = row.infoEl.createDiv("quick-actions-empty-row");
        textButton(buttons, "plus", "New action", newAction, true);
        for (const starter of STARTERS) {
          textButton(buttons, starter.icon, starter.title, () => this.editAction(starter.make())).setAttr("aria-label", starter.desc);
        }
      });
    }
    filter();
    const list = rows[0]?.el.parentElement;
    if (list) {
      this.disposeDrag = enableDragReorder(list, {
        itemSelector: ".quick-actions-row",
        handleSelector: ".quick-actions-grip",
        onReorder: (from, to) => {
          moveItem(actions, from, to);
          this.save();
        },
      });
    }

    const modelGroup = new SettingGroup(containerEl)
      .setHeading("Models")
      .addClass("mod-list")
      .addExtraButton((b) =>
        b
          .setIcon("plus")
          .setTooltip("New model")
          .onClick(() => this.editModel({ name: "", provider: "anthropic", model: "", secret_id: "" })),
      );
    models.forEach((model, i) => modelGroup.addSetting((row) => this.modelRow(row, model, i)));
    if (models.length === 0) {
      modelGroup.addSetting((row) => {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- Ask a model is a step name
        row.setName("No models yet").setDesc("Only needed for Ask a model steps.");
        row.settingEl.addClass("mod-empty-state");
      });
    }
  }

  hide(): void {
    this.disposeDrag?.();
    this.disposeDrag = null;
    this.query = "";
  }

  // Icon, name with its step count and last run, and its steps on one line. Set hotkey and the
  // ribbon toggle show on hover until set. A set hotkey shows as its key.
  private actionRow(row: Setting, action: Action, index: number, usedAt: number | undefined): void {
    const { actions, models } = this.plugin.settings;
    row.settingEl.addClass("quick-actions-row", "mod-navigable");
    rowIcon(row, action.icon);
    const count = stepCount(action.steps);
    const meta = [count ? plural(count, "step", "steps") : "", usedAt ? usedLabel(usedAt) : ""].filter((s) => s).join(" · ");
    row.setName(
      createFragment((f) => {
        f.appendText(action.name || "Untitled action");
        f.createSpan({ cls: "u-muted u-small quick-actions-meta", text: meta });
      }),
    );
    flowEl(row.descEl, action.steps, { app: this.app, models });
    const open = () => this.editAction(action);
    openOnClick(row, open);

    const query = `${this.plugin.manifest.name}: ${action.name}`;
    const hotkey = hotkeyLabel(this.app, `${this.plugin.manifest.id}:${actionCommandId(action)}`);
    if (hotkey) {
      const chip = row.controlEl.createSpan({ cls: "setting-hotkey", text: hotkey, attr: { "aria-label": "Change hotkey" } });
      chip.addEventListener("click", () => openHotkeys(this.app, query));
    } else {
      row.addExtraButton((b) => {
        b.setIcon("plus-circle")
          .setTooltip("Set hotkey")
          .onClick(() => openHotkeys(this.app, query));
        b.extraSettingsEl.addClass("quick-actions-hover-only");
      });
    }
    row.addExtraButton((b) => {
      b.setIcon("panel-left")
        .setTooltip(action.ribbon ? "Remove from the ribbon" : "Show in the ribbon")
        .onClick(() => {
          action.ribbon = !action.ribbon;
          this.save();
        });
      b.extraSettingsEl.addClass(action.ribbon ? "is-active" : "quick-actions-hover-only");
    });
    row.addExtraButton((b) =>
      b
        .setIcon("ellipsis-vertical")
        .setTooltip("More")
        .onClick(() =>
          showRowMenu(b.extraSettingsEl, {
            extra: [
              { title: "Edit", icon: "pencil", click: open },
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
    const grip = row.settingEl.createDiv("quick-actions-grip");
    setIcon(grip, "grip-vertical");
  }

  // Name, model ID and how many steps run on it. Why its steps can't run on this device shows in red.
  private modelRow(row: Setting, model: ModelConfig, index: number): void {
    const { actions, models } = this.plugin.settings;
    row.settingEl.addClass("quick-actions-row", "mod-navigable");
    rowIcon(row, STEP_DEFS.llm.icon, "is-llm");
    row.setName(
      createFragment((f) => {
        f.appendText(model.name || "Unnamed model");
        if (model.model) f.createSpan({ cls: "u-muted u-small quick-actions-meta quick-actions-mono", text: model.model });
      }),
    );
    const problem = modelProblem(this.app, model);
    if (problem) row.descEl.createSpan({ cls: "quick-actions-error", text: problem });
    row.controlEl.createSpan({ cls: "quick-actions-count", text: plural(modelUses(actions, models, model).length, "step", "steps") });
    const open = () => this.editModel(model);
    openOnClick(row, open);
    row.addExtraButton((b) =>
      b
        .setIcon("ellipsis-vertical")
        .setTooltip("More")
        .onClick(() =>
          showRowMenu(b.extraSettingsEl, {
            extra: [
              { title: "Edit", icon: "pencil", click: open },
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
              const users = this.stepsNaming(model).length;
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
    const { actions, models } = this.plugin.settings;
    const existing = models.includes(source) ? source : null;
    const others = models.filter((m) => m !== existing);
    // A new model goes last, which makes it the one unnamed steps run on when it is the only one.
    const uses = modelUses(actions, existing ? models : [...models, source], source);
    new ModelEditModal(this.app, source, others, uses, (result) => {
      if (existing) {
        const users = existing.name !== result.name ? this.stepsNaming(existing) : [];
        for (const step of users) step.model = result.name;
        if (users.length) new Notice(`Renamed ${existing.name} to ${result.name} in ${plural(users.length, "step", "steps")}`);
        Object.assign(existing, result);
      } else {
        this.plugin.settings.models.push(result);
      }
      this.save();
    }).open();
  }

  // The steps that name this model. A rename updates them and a delete stops them. Steps that name
  // no model follow whichever model is first.
  private stepsNaming(model: ModelConfig): LLMStep[] {
    const { actions, models } = this.plugin.settings;
    return modelUses(actions, models, model)
      .filter((u) => u.step.model === model.name)
      .map((u) => u.step);
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
