// Starter actions offered by the empty settings page. Each make() returns a
// fresh Action, and nothing is stored until the user saves the editor.
import { Action, makeAction } from "./types";
import { stepWith } from "./steps";

export interface Starter {
  title: string;
  icon: string;
  desc: string;
  make: () => Action;
}

export const STARTERS: Starter[] = [
  {
    title: "Capture a note",
    icon: "pencil-line",
    desc: "Ask for a thought, write it to a new note, open it.",
    make: () => ({
      ...makeAction("Capture a note", [
        stepWith("prompt", { variable: "thought", label: "What's on your mind?", multiline: true }),
        stepWith("create_file", { path: "Inbox/{{timestamp}}", content: "---\ncreated: \"{{date}}\"\n---\n\n{{thought}}" }),
        stepWith("open_file", { target: "{{note}}" }),
      ]),
      icon: "pencil-line",
    }),
  },
  {
    title: "Append to a log",
    icon: "list-plus",
    desc: "Pick a log, ask for an entry, add it under a heading.",
    make: () => ({
      ...makeAction("Append to a log", [
        stepWith("file_picker", { variable: "log", label: "Which log?", folder: "Logs/" }),
        stepWith("prompt", { variable: "entry", label: "Log entry" }),
        stepWith("insert_in_section", { target: "{{log}}", section: "# Log", format: "- {{date}} {{time}} {{entry}}" }),
      ]),
      icon: "list-plus",
    }),
  },
  {
    title: "Draft with a model",
    icon: "sparkles",
    desc: "Ask for an idea, have a model draft it, save and open the draft.",
    make: () => ({
      ...makeAction("Draft with a model", [
        stepWith("prompt", { variable: "idea", label: "What should the draft be about?", multiline: true, default: "{{selection}}" }),
        stepWith("llm", { variable: "draft", system_prompt: "You write short, clear first drafts in plain prose. Reply with the draft only.", user_prompt: "{{idea}}" }),
        stepWith("create_file", { path: "Drafts/{{timestamp}}", content: "{{draft}}\n\n---\n\nOriginal idea:\n\n{{idea}}" }),
        stepWith("open_file", { target: "{{note}}" }),
      ]),
      icon: "sparkles",
    }),
  },
];
