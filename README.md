# Quick Actions

Configurable quick actions for common vault operations. Build custom commands from composable steps.

## Features

- **Composable step pipelines** - chain steps into a single command
- **Visible data flow** - every step shows what it can use from the steps above it and what it hands down; variables are pills, not text you have to remember
- **Test runs** - run an action up to any step with real prompts and models, see every captured value, and write nothing
- **LLM integration** - call Anthropic or OpenAI models as steps, with the reply available to later steps
- **Multiple named models** - configure several models and choose per step which to use
- **File creation and editing** - create new files or insert text under a heading in an existing file
- **Interactive inputs** - ask for text, pick a file from a folder, or present a list of options
- **Auto-registered commands** - every action becomes an Obsidian command, reachable from the command palette, a hotkey, or its URI
- **Mobile support** - works on desktop and mobile (the pill editor falls back to a plain text field on mobile)

## Step types

Steps are grouped by what they do. Steps that produce a value name their output; later steps use it as `{{name}}`.

| Group | Step | What it does | Output |
|---|---|---|---|
| Ask | **Ask me** | A question with a text box (single or multi-line) | text |
| Ask | **Choice** | Pick one option from a list | text |
| Ask | **Pick a file** | Choose a note from a folder | file |
| Ask | **Tasks modal** | Build a task line with the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) modal (requires Tasks) | text |
| Generate | **Ask a model** | Send a system and user prompt to a configured model, keep the reply | text |
| Do | **Create file** | Write a new note from a templated path and content | file |
| Do | **Insert in section** | Add text under a heading in a note, at the start or end of the section | nothing |
| Do | **Open file** | Open a note, optionally scrolled to a heading | nothing |

A `file` output is a vault path. **Insert in section** and **Open file** take a file as their target, so a `Create file` step followed by `Open file` with target `{{note}}` opens the note that was just created.

## Variables

Every templated field (paths, content, prompts, targets, sections) accepts `{{name}}`. In the editor these render as pills. Type `{{` to pick from what is available at that step, click a pill in the **In** band to insert it at the caret, or press the `{ }` button. Pills that nothing above produces render red.

**Built-in variables** (available in every step):

| Variable | Value |
|---|---|
| `{{date}}` | Current date as `YYYY-MM-DD` |
| `{{time}}` | Current time as `HH:mm` |
| `{{timestamp}}` | Current timestamp as `YYYYMMDDHHmmss` |

**Step outputs** - each producing step names its output in the **Out** band. Click the name to rename it; every later use is rewritten. Names must be a single word (letters, digits, underscores) that no other step produces.

## The action editor

The editor is a two-pane modal: the steps on the left, the selected step on the right.

- **In band** - every value this step could use. Tinted pills are used by this step, outlined ones are available, blue ones are files.
- **Fields** - what the step needs. Templated fields hold pills.
- **Out band** - what this step produces, and which later steps use it.
- **Add step** - a grouped picker (Ask, Generate, Do). Steps reorder by drag or from the `⋯` menu.
- **Test run** / **Run to here** - runs the steps up to the selected one. Prompts and models are real, nothing is written to the vault. The rail shows each captured value, and the **Last run** view of a step shows the prompt that was sent with every substituted value marked, what it produced, and what the next step would create. **Run step N too** continues the same run without asking again. **Discard run** returns to editing.
- **Save** (or Cmd-Enter) writes the action; **Cancel** discards every change.

## LLM integration

### Setting up models

1. Store the API key in **Settings > Keychain**.
2. Go to **Settings > Quick Actions > Models** and click **Add model**.
3. Give it a name (this is what steps show), choose a provider, enter the model ID, and pick the Keychain secret.
4. Press **Test** to confirm the key and model ID; the reply time and model ID appear inline, or the provider's error.

Several models can be configured (a fast one for classification, a capable one for drafting) and each **Ask a model** step picks one. A step with no model set uses the first one.

### Supported providers

| Provider | API | Auth header |
|---|---|---|
| **Anthropic** | Messages API (`/v1/messages`) | `x-api-key` |
| **OpenAI** | Chat Completions API (`/v1/chat/completions`) | `Authorization: Bearer` |

## Starters

An empty settings page offers three starters that open a prefilled editor: **Capture a note** (ask, create a note, open it), **Append to a log** (pick a log, ask for an entry, insert it under a heading), and **Draft with a model** (ask for an idea, have a model draft it, save and open the draft). Nothing is stored until you save.

## Examples

### Capture Fleeting Note

| Step | Type | Details |
|---|---|---|
| 1 | Ask me | "Fleeting thought:", multi-line, output `thought` |
| 2 | Create file | Path `Inbox/F-{{timestamp}}`, content includes `{{thought}}`, output `note` |
| 3 | Open file | Target `{{note}}` |

### Draft Slipbox Note

| Step | Type | Details |
|---|---|---|
| 1 | Ask me | "Rough idea or observation:", multi-line, output `idea` |
| 2 | Ask a model (Opus) | Drafts the note body from `{{idea}}`, output `draft` |
| 3 | Ask a model (Haiku) | Generates a short title from `{{draft}}` and `{{idea}}`, output `title` |
| 4 | Create file | Path `Slipbox/{{timestamp}} - {{title}}`, content uses `{{title}}`, `{{draft}}`, `{{idea}}`, output `note` |
| 5 | Open file | Target `{{note}}`, scrolled to `## Description` |

## Development

```bash
npm install
npm run build   # bundle to main.js
npm run lint    # eslint with the obsidianmd rules
npm test        # unit tests for the pure modules (variables, step table)
```

## Installation

### Manual

```bash
git clone https://github.com/matiasvc/obsidian-quick-actions.git
cd obsidian-quick-actions
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-quick-actions/` directory and enable the plugin in Settings > Community plugins.

## License

MIT
