import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";

export class PromptModal extends Modal {
	private resolve: (value: string | null) => void;
	private label: string;
	private multiline: boolean;
	private value = "";
	private submitted = false;

	constructor(app: App, label: string, multiline: boolean, resolve: (value: string | null) => void) {
		super(app);
		this.label = label;
		this.multiline = multiline;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("label", { text: this.label });

		if (this.multiline) {
			const textarea = contentEl.createEl("textarea");
			textarea.addClass("quick-actions-prompt-textarea");
			textarea.rows = 6;
			textarea.focus();
			textarea.addEventListener("input", () => { this.value = textarea.value; });
			textarea.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					this.submitted = true;
					this.close();
				}
			});
			const footer = contentEl.createDiv("quick-actions-prompt-footer");
			const btn = footer.createEl("button", { text: "Submit" });
			btn.addClass("mod-cta");
			btn.addEventListener("click", () => {
				this.submitted = true;
				this.close();
			});
		} else {
			const input = contentEl.createEl("input", { type: "text" });
			input.addClass("quick-actions-prompt-input");
			input.focus();
			input.addEventListener("input", () => { this.value = input.value; });
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					this.submitted = true;
					this.close();
				}
			});
		}
	}

	onClose() {
		if (this.submitted) {
			this.resolve(this.value || null);
		} else {
			this.resolve(null);
		}
	}
}

export function openPromptModal(app: App, label: string, multiline: boolean): Promise<string | null> {
	return new Promise((resolve) => {
		new PromptModal(app, label, multiline, resolve).open();
	});
}

export class FilePickerModal extends FuzzySuggestModal<TFile> {
	private resolve: (value: TFile | null) => void;
	private files: TFile[];
	private picked = false;

	constructor(app: App, files: TFile[], resolve: (value: TFile | null) => void) {
		super(app);
		this.files = files;
		this.resolve = resolve;
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(item: TFile): string {
		return item.basename;
	}

	onChooseItem(item: TFile) {
		this.picked = true;
		this.resolve(item);
	}

	onClose() {
		// Small delay so onChooseItem fires first if an item was selected
		setTimeout(() => {
			if (!this.picked) {
				this.resolve(null);
			}
		}, 50);
	}
}

export class ChoiceModal extends FuzzySuggestModal<string> {
	private resolve: (value: string | null) => void;
	private options: string[];
	private picked = false;

	constructor(app: App, label: string, options: string[], resolve: (value: string | null) => void) {
		super(app);
		this.options = options;
		this.resolve = resolve;
		this.setPlaceholder(label);
	}

	getItems(): string[] {
		return this.options;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string) {
		this.picked = true;
		this.resolve(item);
	}

	onClose() {
		setTimeout(() => {
			if (!this.picked) {
				this.resolve(null);
			}
		}, 50);
	}
}

export function openChoiceModal(app: App, label: string, options: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		new ChoiceModal(app, label, options, resolve).open();
	});
}

export function openFilePickerModal(app: App, folder: string): Promise<string | null> {
	const files = app.vault.getMarkdownFiles()
		.filter((f) => f.path.startsWith(folder))
		.sort((a, b) => a.basename.localeCompare(b.basename));

	if (files.length === 0) {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		new FilePickerModal(app, files, (file) => {
			resolve(file ? file.path : null);
		}).open();
	});
}
