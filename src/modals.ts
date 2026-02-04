import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";

export class PromptModal extends Modal {
	private resolve: (value: string | null) => void;
	private label: string;
	private inputEl: HTMLInputElement;
	private submitted = false;

	constructor(app: App, label: string, resolve: (value: string | null) => void) {
		super(app);
		this.label = label;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("label", { text: this.label });
		this.inputEl = contentEl.createEl("input", { type: "text" });
		this.inputEl.addClass("quick-actions-prompt-input");
		this.inputEl.focus();
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.submitted = true;
				this.close();
			}
		});
	}

	onClose() {
		if (this.submitted) {
			this.resolve(this.inputEl.value || null);
		} else {
			this.resolve(null);
		}
	}
}

export function openPromptModal(app: App, label: string): Promise<string | null> {
	return new Promise((resolve) => {
		new PromptModal(app, label, resolve).open();
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
