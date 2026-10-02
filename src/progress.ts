import { Notice, ProgressBarComponent } from "obsidian";
import { ModelConfig, Step } from "./types";
import { STEP_DEFS, modelOf, replyOutputs, withoutUnavailable } from "./steps";
import { noticeLink } from "./ui";

export interface StepEvent {
  number: number; // as the editor numbers it, which skips an If block's other markers
  step: Step;
}

// What a step is doing while it runs on its own, or null for a step that is waiting for you.
function activityOf(step: Step, models: ModelConfig[]): string | null {
  if (step.type === "llm") {
    const model = modelOf(step, models)?.name ?? "the model";
    const usable = withoutUnavailable(step, models);
    const web = usable.webSearch ? ", searching the web" : usable.webFetch ? ", reading pages" : "";
    if (step.name?.trim()) return `${step.name.trim()} with ${model}${web}`;
    return `Asking ${model} for ${replyOutputs(step).map((o) => o.name).join(", ")}${web}`;
  }
  return STEP_DEFS[step.type].activity ?? null;
}

// One notice for a whole run: the action, which step is running, its seconds so far and a Cancel
// link. It hides while a step waits for you, so it never covers a prompt, and clicks on it don't
// dismiss it, since it goes away when the run ends.
export class RunProgress {
  cancelled = false;
  private notice: Notice | null = null;
  private timer: number | null = null;
  private lineEl: HTMLElement | null = null;
  private bar: ProgressBarComponent | null = null;
  private text = "";
  private started = 0;

  constructor(
    private title: string,
    private total: number,
    private models: ModelConfig[],
  ) {}

  step(event: StepEvent): void {
    const activity = activityOf(event.step, this.models);
    if (activity === null) {
      this.hide();
      return;
    }
    this.text = `Step ${event.number} of ${this.total} · ${activity}`;
    this.started = Date.now();
    this.ensure();
    this.bar?.setValue(Math.round(((event.number - 1) / this.total) * 100));
    this.tick();
  }

  private ensure(): void {
    if (this.notice) return;
    const notice = new Notice("", 0);
    this.notice = notice;
    const el = notice.messageEl;
    el.addClass("quick-actions-notice");
    el.addEventListener("click", (evt) => evt.stopPropagation());
    el.createEl("b", { text: this.title });
    this.lineEl = el.createDiv();
    this.bar = new ProgressBarComponent(el);
    const cancel = noticeLink(notice, el.createDiv("quick-actions-notice-acts"), {
      text: "Cancel",
      keep: true,
      click: () => {
        this.cancelled = true;
        cancel.remove();
        this.tick();
      },
    });
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    if (!this.lineEl) return;
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    this.lineEl.setText(this.cancelled ? "Stopping after this step…" : `${this.text}${seconds > 0 ? ` · ${seconds} s` : ""}`);
  }

  hide(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.notice?.hide();
    this.notice = null;
    this.lineEl = null;
    this.bar = null;
  }
}
