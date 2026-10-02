import { AbstractInputSuggest, TFolder } from "obsidian";

// Folder completion for plain text inputs in the editors.

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    const folders = this.app.vault.getAllFolders().filter((f) => f.path.toLowerCase().contains(lower));
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
