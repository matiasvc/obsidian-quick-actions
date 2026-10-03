# Quick Actions

Configurable quick actions for common vault operations. Build custom commands from composable steps.

## Features

- **Composable step pipelines.** Chain steps into a single command, with If blocks that run one of several branches.
- **Visible data flow.** Every step shows what it can use from the steps above it and what it hands down. Variables are pills, not text you have to remember, and filters shape them on the way in.
- **Test runs.** Run an action up to any step with real prompts and models, see every captured value and where an insert would land, and write nothing.
- **Safe runs.** One notice shows progress and can cancel. A failed step offers Retry with everything already typed or generated, and a finished run offers Undo.
- **LLM integration.** Call Anthropic or OpenAI models as steps, with attached images and PDFs and the provider's web search. Keep the reply as one value or as several fields from one call.
- **Web pages.** Fetch a page as Markdown so a model reads the page itself, not just its URL.
- **File creation and editing.** Create new files or insert text under a heading in an existing file.
- **Interactive inputs.** Ask for text, pick a file from a folder, present a list of options, or type a task into the Quick Tasks box. Start from the text you selected or copied.
- **Commands everywhere.** Every action becomes an Obsidian command with its own icon, reachable from the command palette, a hotkey, the ribbon, the phone toolbar, the **Run a quick action** launcher, or its URI.
- **Mobile support.** Works on desktop and mobile. The pill editor falls back to a plain text field on mobile.

## Step types

Steps are grouped by what they do. Steps that produce a value name their output, and later steps use it as `{{name}}`.

| Group | Step | What it does | Output |
|---|---|---|---|
| Ask | **Ask me** | A question with a text box (single or multi-line). **Default** fills the box when it opens, for example with `{{selection}}` | text |
| Ask | **Choice** | Pick one option from a list | text |
| Ask | **Pick a file** | Choose a note, an image or PDF, or any file from a folder. **Question** is shown in the search box, files you picked recently come first, and each row shows its folder and last edit | file |
| Ask | **Quick task** | Type a task into the [Quick Tasks](https://github.com/matiasvc/obsidian-quick-tasks) quick-add box (dates, `!priority`, `#tags`, `@project`, repeat phrases) and create its note. Optional project link and prefilled text. Requires Quick Tasks | file |
| Fetch and generate | **Fetch page** | Download the page at a URL, or the first URL in a value, as Markdown with its title. **When there is no page**, because the value has no URL or the fetch failed, the text passes through as the page with an empty title, or the action stops if you choose | text (page and its title) |
| Fetch and generate | **Ask a model** | Send a system and user prompt to a configured model, with images and PDFs attached, and let it search the web or read linked pages. **Reply** is one value, or several named fields the model fills in one call | text (one or more, and the sources when on the web) |
| Do | **Create file** | Write a new note from a templated path and content. Missing folders are created | file |
| Do | **Insert in section** | Add text under a heading in a note, at the start or end of the section | nothing |
| Do | **Open file** | Open a note in the current tab, a new tab or a split, optionally with the cursor under a heading | nothing |
| Flow | **If** | Run one of several branches of steps, picked by tests. See [If blocks](#if-blocks) | what its branches set |
| Flow | **Set a value** | Turn a template into a named value. The last step that sets a name wins | text |
| Flow | **Stop** | End the action here, as finished, with an optional message | nothing |

A `file` output is a vault path. **Insert in section** and **Open file** take a file as their target, so a `Create file` step followed by `Open file` with target `{{note}}` opens the note that was just created.

**Quick task** produces the new task note, and `Open file` with target `{{task}}` opens it. Its **Project** field (a note from an earlier step, or a path) is the note Quick Tasks embeds the task in, where its own quick add would put it, so no `Insert in section` step is needed for it. `Insert in section` with the text `![[{{task}}]]` still embeds the task in any other note as Quick Tasks' live widget. **Prefill** is typed into the box before you start. Without the Quick Tasks plugin the step fails with a notice and the editor shows a warning on the step. A test run opens the box and reports what it would create without writing the note.

**Ask a model** with several values lists each field with a name, a description the model reads, and optional choices. A field with choices can only be one of them, so a classifier can't invent a category. Both providers answer through their JSON schema output. A reply that was refused, or cut off at the output limit or the model's context window, fails the step instead of passing on a partial answer.

**Search the web** lets the model run up to 5 searches through the provider's own web search (about a cent each, on both Anthropic and OpenAI). **Read linked pages** lets an Anthropic model open up to 5 URLs that appear in the user prompt. OpenAI has no tool for that, so the option is off for OpenAI models, whose web search opens the pages it finds, and picking an OpenAI model resets it. With either on, the reply is the model's answer without its lead-in ("I'll search for…"), and the step also hands down `{{sources}}`, a Markdown list of links to the pages the answer cites and the pages it read. When the reply cites nothing, as with several values, `{{sources}}` lists the pages its searches found instead. Rename the value in the Out band like any other. A step on the web can take several seconds, and the run notice says it is searching or reading pages.

**Attach** sends images (PNG, JPEG, GIF, WebP) and PDFs from the vault with the prompt: a file from an earlier step such as `{{file}}`, or a path, several separated by commas. A note sends the images and PDFs it embeds, so `{{active_note}}` sends the screenshots pasted into the note you are in. Files go inline with the request, which works on the phone too. Before anything is read, the total is checked against what the provider takes in one request (32 MB for Anthropic, 50 MB for OpenAI). A missing file, a file of another kind or too much data fails the step with the file names. A test run lists what was attached. **Pick a file** with **Files** set to Images and PDFs offers exactly the files a model can take. An image costs roughly 1,000 to 5,000 tokens and a PDF page 1,500 to 3,000.

**Insert in section** writes through the note's editor when the note is open for editing, so the entry lands next to anything you have typed and not saved yet. Otherwise it changes the file in one step with `vault.process`.

### If blocks

An **If** block holds steps in branches. Its first branch runs when its tests pass. Any **Else if** branches are tried in order after it, and an **Else** runs when no branch above it does. At most one branch runs, and the run goes on after the block.

- **Tests.** Each branch tests one or more values: has text, is empty, is, is not, contains, does not contain, or matches a pattern (a regular expression). Comparisons ignore case and the spaces around a value. With several tests, the branch runs when all of them pass or when any does.
- **The step list.** The block is a framed box: the If is its header, each Else if and Else a divider, and the bottom edge closes it. Drag steps into and out of its branches. A step's ⋯ menu also has **Put in an If**, **Move into** each branch, and **Move out of the If block**, which is how steps move on a phone. Dragging the If moves the whole block, and blocks can sit inside branches of other blocks.
- **The If's own settings.** Selecting the If shows one row per branch with its tests, and buttons for a new Else if or Else. Removing a branch moves its steps below the block. **Remove If, keep its steps** in the ⋯ menu takes the block away and leaves its steps, and **Delete** removes the block with its steps.
- **Values.** A step in a branch sees the values from before the block and from its own branch, not from the branches beside it. After the block, a value any branch set is there. Its pill is dashed when it can be empty after the block. That happens when not every branch sets it or there is no Else, and it had no value before the block. Renaming a value a block sets in several branches renames it in all of them.
- **Runs.** A test run notes which branch ran and marks the steps of the others as not taken. Outputs of a branch that did not run are empty, so later steps never see a bare `{{name}}`.
- **Numbers.** Steps are numbered in order, counting the If but not its dividers or end.

## Variables

Every templated field (paths, content, prompts, targets, sections) accepts `{{name}}`. In the editor these render as pills. Type `{{` to pick from what is available at that step, click a pill in the **In** band to insert it at the caret, or press the `{ }` button. Pills that nothing above produces render red.

**Built-in variables** (available in every step):

| Variable | Value |
|---|---|
| `{{date}}` | Current date as `YYYY-MM-DD` |
| `{{time}}` | Current time as `HH:mm` |
| `{{timestamp}}` | Current timestamp as `YYYYMMDDHHmmss` |
| `{{selection}}` | The text selected in the note you were in when the action started |
| `{{clipboard}}` | What you last copied. Only read when a step uses it |
| `{{active_note}}` | The path of the note you were in (a file) |
| `{{active_title}}` | That note's name |

**Step outputs.** Each producing step names its outputs in the **Out** band. Click a name to rename it, and every later use is rewritten. Names must be a single word (letters, digits, underscores). Two steps may share one only when one is a Set a value or they sit in different branches of an If.

**Filters** change a value where it is used: `{{category|slug}}`. Click a pill in a field to add or remove them, or on mobile use the `{ }` menu with the cursor after a value. They apply in order, so `{{reply|first_line|trim}}` works.

| Filter | Does | Example |
|---|---|---|
| `slug` | Lowercase words joined by dashes, for tags | `Blog Post` → `blog-post` |
| `lower` | Lowercase | `Paper` → `paper` |
| `trim` | No spaces or blank lines at either end | `  Paper  ` → `Paper` |
| `first_line` | The first line that has text | |
| `filename` | Safe to use in a file name | `io_uring: why it exists` → `io_uring - why it exists` |
| `yaml` | Escaped for a double-quoted frontmatter value | `The "what" effect` → `The \"what\" effect` |
| `link` | A file as a link, in the vault's link format | `Reference Notes/ENet.md` → `[[ENet]]` |

Two kinds of cleaning happen without a filter. In a path (the **Create file** path, and the file and template fields of **Insert in section** and **Open file**), values typed into Ask me, generated by a model, fetched from a page or set by Set a value, and the selection, clipboard, note title and time, are made safe for a file name. A value some step produces as a file is never cleaned, and neither is a Set a value whose value is just such a file. So a colon or slash in a generated title can't fail the step or add a folder, and `{{time}}` becomes `13.52`. Values from Choice and Pick a file keep their slashes, and the path is normalized, so a stray `//` does no harm. In the frontmatter block of a **Create file** content, each value is escaped for the quotes around it, so a title with a double quote still gives valid YAML. Model replies are trimmed.

## The action editor

The editor is a two-pane modal: the steps on the left, the selected step on the right.

- **Header.** The icon button sets the action's icon and whether it gets a ribbon button. The link button copies its URI.
- **Step name.** Next to the step type. Shown in the rail, in the settings list and wherever the step is mentioned. A model step without a name reads as its model and output, like `Sonnet → title`.
- **In band.** Every value this step could use. Tinted pills are used by this step, outlined ones are available, blue ones are files.
- **Fields.** What the step needs. Templated fields hold pills. A multi-line field longer than six lines shows its first four until you click into it or on **Show all**.
- **Out band.** What this step produces, and which later steps use it.
- **Add step.** A grouped picker (Ask, Fetch and generate, Do, Flow). The new step goes just after the selected one, or at the start of the first branch when an If is selected. Steps reorder by drag or from the `⋯` menu.
- **Test run** / **Run to here.** Runs the steps up to the selected one. Prompts, page fetches and models are real, and nothing is written to the vault. The rail shows each captured value, and the **Last run** view of a step shows the prompt that was sent with every substituted value marked, what it produced, the lines around where an insert would land, and what the next step would create. **Run step N too** continues the same run without asking again. **Discard run** returns to editing.
- **Save** (or Cmd/Ctrl-Enter) writes the action. **Cancel**, Esc and the close button ask before throwing away changes, and a second Esc discards.

## Running actions

- **Launcher.** The **Run a quick action** command lists every action, most recently run first. Give it one hotkey or one phone toolbar button instead of one per action.
- **Prompts** show the action's name, the question and the key that saves. Text in a prompt closed by accident comes back the next time it opens, for a day. Cancel throws it away.
- **Progress.** While steps run without you, one notice shows the step, what it is doing, the seconds so far and a Cancel link. A model call already sent finishes, and the run stops after it.
- **Failure.** The notice names the step and the error, with **Retry step N**, which reruns from that step with every value already captured, and **Copy what you typed**.
- **Undo.** The finishing notice offers Undo for ten seconds, and a failed or cancelled run offers it too. It covers everything the run wrote, including what it wrote before a Retry. Inserted lines come out, created notes go to the trash, and folders the run created go too when empty. Quick Tasks notes are left to Quick Tasks.
- **URI.** `obsidian://quick-actions?vault=<vault>&run=<action id>` runs an action, and **Copy URI** copies that form. An action's id never changes, so the link survives a rename. The old form with the name's slug still works. Any other parameter fills the Ask me, Choice or Pick a file step that produces that name, and that step doesn't ask, so `&thought=Call%20the%20garage` captures a fleeting note in one go from a phone shortcut.

## LLM integration

### Setting up models

1. Store the API key in **Settings > Keychain**.
2. Go to **Settings > Quick Actions > Models** and click **Add model**.
3. Give it a name (this is what steps show), choose a provider, pick the Keychain secret, and pick the model ID from the provider's list or type one.
4. Press **Test** to confirm the key and model ID. The reply time and model ID appear inline, or the provider's error.

Several models can be configured (a fast one for classification, a capable one for drafting) and each **Ask a model** step picks one. A step with no model set uses the first one. Model names are unique. Renaming a model updates the steps that use it. A step whose model was deleted is marked red in the editor and stops the action instead of running on another model.

**Output limit** is the most tokens a reply may use, thinking included. Empty means 16,000 for Anthropic, which requires a limit, and no limit for OpenAI. A reply that reaches it fails the step, so raise it if long drafts get cut off.

Each **Ask a model** step has an **Effort**: Model default, Low, Medium, High, Extra high or Max. Low is faster and cheaper, which suits classification, and High or Max suits drafting. Since it is per step, one model can do both. Haiku models have no effort setting, so the editor turns it off for them, and picking a Haiku model resets it. A model that rejects a value, such as an OpenAI model without reasoning, fails the step with the provider's message.

### Supported providers

| Provider | API | Auth header |
|---|---|---|
| **Anthropic** | Messages API (`/v1/messages`), model list (`/v1/models`) | `x-api-key` |
| **OpenAI** | Responses API (`/v1/responses`, with `store: false` so OpenAI doesn't keep the response for later retrieval), model list (`/v1/models`) | `Authorization: Bearer` |

## Starters

An empty settings page offers three starters that open a prefilled editor: **Capture a note** (ask, create a note, open it), **Append to a log** (pick a log, ask for an entry, insert it under a heading), and **Draft with a model** (ask for an idea, starting from the selection, have a model draft it, save and open the draft). Nothing is stored until you save.

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

### Reference note from a link

| Step | Type | Details |
|---|---|---|
| 1 | Ask me | "Paste a URL or describe the source:", output `source` |
| 2 | Fetch page | URL `{{source}}`, outputs `page` and `page_title` |
| 3 | Ask a model | User prompt `{{page}}`, several values: `category` (choices Article, Paper, Video), `title`, `body` |
| 4 | Create file | Path `Reference Notes/{{timestamp}} - {{category}} - {{title}}`, tag `{{category|slug}}`, body `{{body}}` |

## TODO

Planned features, by area.

### Getting more from a link

- **Richer page details.** Fetch page also hands down the address after redirects (so short links expand), the canonical URL, the author, site, published date, description and lead image.

### Reading the vault

- **Read a note.** A step that hands down a note's body, each frontmatter field as its own value, and the last line under a heading.
- **Remember the last answer.** Ask me can default to what you typed the last time that step ran, so a repeated entry takes one tap.
- **Choices from the vault.** Choice takes its options from the vault: a property's existing values, tags, a note's headings or a note's lines, with typing a new value allowed.
- **Resurface a note.** An input that picks a note by a rule: random, on this day, least recently touched, or spaced. A variant brings a fleeting note back at growing intervals with Promote, Merge and Let go.
- **The page you are reading.** `{{web_url}}` and `{{web_title}}` from the open Web viewer tab, on desktop.
- **Link to the cursor.** Adds a block ID at the cursor, or takes the heading above it, and hands down a link to that exact spot.

### Writing to the vault

- **Set property.** Set, add to or remove a frontmatter property through Obsidian's frontmatter writer, so quoting stays consistent.
- **Move or rename a note.** Moves a note with its links updated and hands down the new path.
- **Write at the cursor.** Insert at the cursor, replace the selection, or tick the checklist line the cursor is on. Insert in section also gains before or after a matching line, and the top or bottom of the file.
- **Extract to a new note.** Moves the selection into a new note, leaves a link or embed behind, and records the source in the new note's frontmatter.
- **Tasks without the box.** Creates a Quick Tasks note directly from a title, body, note and heading, and can complete a task. Needs additions to the Quick Tasks API.

### Asking you

- **Form.** Several fields on one screen: text, number, toggle, date, time, slider, choice and multi-select, or one fill-in sentence.
- **Dates you can type.** A date field that understands "next friday", and a filter that formats or shifts any date, such as `{{date|add:7d}}`.
- **Follow-up questions.** A model asks one to three questions, only when the capture would not make sense later. An interview mode keeps asking until the step's outputs are filled.
- **Review before writing.** An editable box with Accept, Edit and Reject before later steps use a value.
- **Jot loop.** Asks again after each entry, timestamps each one, stops on an empty entry, and hands down the list.
- **Typed capture.** A note type defined once with its fields and hints. A model fills what it can from free text and asks only for required fields that are still missing.

### Phone

- **Voice memo.** Records audio, keeps it as an attachment, transcribes it with an OpenAI key, and can apply a rewrite style.
- **Photo.** Takes a photo or picks one from the gallery, saves it, hands down its time and place, and can pass it to Attach.
- **Place and weather.** `{{place}}` as a named place rather than coordinates, and `{{weather}}` from Open-Meteo, which needs no key.
- **Share sheet.** Actions appear in the menu Obsidian shows when text or a link is shared to it, and the shared text becomes `{{shared}}`. This relies on an undocumented hook.

### Outside the vault

- **HTTP request.** Method, URL, headers with a Keychain secret and a JSON body, handing down fields picked from the response.

### Flow

- **For each.** Split a value into items, optionally with a model, run the following steps once per item, and collect the results.
- **Run another action.** Call an action and pass it values, so shared parts are built once.
- **More filters.** `replace`, `split`, `join`, `title`, `wikilink`, `list`, `calc`, `default`, a regex match, and `expand_url`. Filters that take arguments change the `{{name|filter}}` syntax and the pill editor.
- **Shared values.** Values defined once in settings that every action can use.
- **Models that search the vault.** Ask a model gets a vault search tool so it can look notes up while it answers. This is a tool loop the plugin runs, separate from web search.

### Editor

- **Pinned test outputs.** Pin a step's test-run output, so editing later steps doesn't call the model or fetch the page again.

## Development

```bash
npm install
npm run build   # bundle to main.js
npm run deploy  # build, copy into $OBSIDIAN_VAULT (default ~/Obsidian) and reload the plugin
npm run lint    # eslint with the obsidianmd rules
npm test        # unit tests for the pure modules
```

## Installation

### Manual

```bash
git clone https://github.com/matiasvc/obsidian-quick-actions.git
cd obsidian-quick-actions
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/quick-actions/` directory and enable the plugin in Settings > Community plugins.

## License

MIT
