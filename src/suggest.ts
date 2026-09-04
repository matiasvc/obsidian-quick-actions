import { AbstractInputSuggest, TFile, TFolder } from "obsidian";

// Path completion for plain text inputs in the editors.

export class FileSuggest extends AbstractInputSuggest<TFile> {
  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().contains(lower))
      .slice(0, 20);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.setValue(file.path);
    this.close();
  }
}

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    const folders: TFolder[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path.toLowerCase().contains(lower)) folders.push(f);
    }
    folders.sort((a, b) => a.path.localeCompare(b.path));
    return folders.slice(0, 20);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path + "/");
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path + "/");
    this.close();
  }
}
