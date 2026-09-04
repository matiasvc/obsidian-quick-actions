// Starter actions offered by the empty settings page. Each make() returns a
// fresh Action; nothing is stored until the user saves the editor.
import { Action, generateId } from "./types";

export interface Starter {
  id: string;
  title: string;
  icon: string;
  desc: string;
  make: () => Action;
}

export const STARTERS: Starter[] = [
  {
    id: "capture",
    title: "Capture a note",
    icon: "pencil-line",
    desc: "Ask for a thought, write it to a new note, open it.",
    make: () => ({
      id: generateId(),
      name: "Capture a note",
      steps: [
        { type: "prompt", variable: "thought", label: "What's on your mind?", multiline: true },
        {
          type: "create_file",
          variable: "note",
          path: "Inbox/{{timestamp}}",
          content: "---\ncreated: \"{{date}}\"\n---\n\n{{thought}}",
        },
        { type: "open_file", target: "{{note}}", section: "" },
      ],
    }),
  },
  {
    id: "log",
    title: "Append to a log",
    icon: "list-plus",
    desc: "Pick a log, ask for an entry, add it under a heading.",
    make: () => ({
      id: generateId(),
      name: "Append to a log",
      steps: [
        { type: "file_picker", variable: "log", folder: "Logs/" },
        { type: "prompt", variable: "entry", label: "Log entry", multiline: false },
        {
          type: "insert_in_section",
          target: "{{log}}",
          section: "# Log",
          position: "end",
          format: "- {{date}} {{time}} {{entry}}",
          createIfMissing: false,
          templatePath: "",
        },
      ],
    }),
  },
  {
    id: "draft",
    title: "Draft with a model",
    icon: "sparkles",
    desc: "Ask for an idea, have a model draft it, save the draft.",
    make: () => ({
      id: generateId(),
      name: "Draft with a model",
      steps: [
        { type: "prompt", variable: "idea", label: "What should the draft be about?", multiline: true },
        {
          type: "llm",
          variable: "draft",
          model: "",
          system_prompt: "You write short, clear first drafts in plain prose. Reply with the draft only.",
          user_prompt: "{{idea}}",
        },
        {
          type: "create_file",
          variable: "note",
          path: "Drafts/{{timestamp}}",
          content: "{{draft}}\n\n---\n\nOriginal idea:\n\n{{idea}}",
        },
        { type: "open_file", target: "{{note}}", section: "" },
      ],
    }),
  },
];
