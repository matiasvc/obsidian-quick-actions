# /// script
# requires-python = ">=3.11"
# ///
"""Generates the per-step editor artboards (Step*.src.html, AddStep.src.html) for the final set.

build.mjs cannot parameterise partials, so the step boards come from one template here. Edit this
file, run `uv run gen-steps.py`, then `node build.mjs`.
"""
import re
from pathlib import Path

HERE = Path(__file__).parent

HEAD = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; background: #1e1e1e; }
    a { color: var(--text-accent); } a:hover { color: var(--text-accent-hover); }
<!--OBSIDIAN_CSS-->
<!--INCLUDE:_qa.css-->
<!--INCLUDE:_qa2.css-->
<!--INCLUDE:_qa4.css-->
<!--INCLUDE:_qa5.css-->
    .RAIL%(active)d { background: var(--background-modifier-hover); }
    .RAIL%(active)d .l3-out { color: var(--text-accent); }
  </style>
</helmet>
<!--INCLUDE:_editor3-top.html-->
%(head)s
          <div class="qa-split l3">
<!--INCLUDE:%(rail)s-->
            <div class="qa-pane" style="position: relative;">
              <div class="l3-head">
                <span class="qa-num">%(active)d</span>
                <select class="dropdown"><option>%(type)s</option></select>
                <span style="flex: 1;"></span>
                <button class="clickable-icon" aria-label="More">{{icon:ellipsis}}</button>
              </div>
              <div class="l3-card">
                <div class="l3-band is-in">
                  <span class="qp-lead">In</span>
%(inputs)s
                </div>
                <div class="l3-body">
%(body)s
                </div>
%(out)s
              </div>
            </div>
          </div>
<!--INCLUDE:_editor-bottom.html-->
</x-dc>
</body>
</html>
"""

EMPTY_PANE = (
    '<div class="qa-pane" style="display: flex; align-items: center; justify-content: center;">'
    '<div style="text-align: center; color: var(--text-faint); font-size: var(--font-ui-small); max-width: 360px;">'
    "Add a step on the left. Each step can use what the steps above it produced, and hands its own result down to the ones below."
    "</div></div>\n          </div>\n<!--INCLUDE:_editor-bottom"
)


def head(name: str) -> str:
    return (HERE / "_head-name.html").read_text().replace("NAME", name)


def pills(used, unused, files=()):
    out = [f'                  <span class="qp{" is-file" if p in files else ""}">{p}</span>' for p in used]
    out += [f'                  <span class="qp is-off">{p}</span>' for p in unused]
    return "\n".join(out)


FIRST = '\n                  <span class="l3-hint">first step, nothing from above yet</span>'


def row(name, control, desc=None):
    d = f'<div class="setting-item-description">{desc}</div>' if desc else ""
    return f"""                  <div class="setting-item">
                    <div class="setting-item-info"><div class="setting-item-name">{name}</div>{d}</div>
                    <div class="setting-item-control">{control}</div>
                  </div>"""


def stacked(name, control):
    return f"""                  <div class="setting-item is-stacked">
                    <div class="setting-item-info"><div class="setting-item-name">{name}</div></div>
                    <div class="setting-item-control">{control}</div>
                  </div>"""


def out(pill, meta, file=False):
    return f"""                <div class="l3-band is-out">
                  <span class="qp-lead">Out</span>
                  <span class="qp{" is-file" if file else ""}">{pill}</span>
                  <span class="l3-hint">{meta}</span>
                </div>"""


def out_none(text):
    return f"""                <div class="l3-band is-out">
                  <span class="qp-lead">Out</span>
                  <span class="l3-hint">{text}</span>
                </div>"""


def field(text, extra=""):
    return f'<div class="qa-field" style="width: 100%; {extra}">{text}</div>'


def P(n, cls=""):
    return f'<span class="qp{" " + cls if cls else ""}">{n}</span>'


BUILTINS = ["date", "time", "timestamp"]
TOGGLE_ON = '<div class="checkbox-container is-enabled"><input type="checkbox" checked></div>'
TOGGLE_OFF = '<div class="checkbox-container"><input type="checkbox"></div>'

OPTIONS = """<div class="l3-options">
                      <div class="l3-option"><span class="qa-grip">{{icon:grip-vertical}}</span><input type="text" value="Daily log"><button class="clickable-icon" aria-label="Remove">{{icon:x}}</button></div>
                      <div class="l3-option"><span class="qa-grip">{{icon:grip-vertical}}</span><input type="text" value="Work log"><button class="clickable-icon" aria-label="Remove">{{icon:x}}</button></div>
                      <div class="l3-option"><span class="qa-grip">{{icon:grip-vertical}}</span><input type="text" value="Reading log"><button class="clickable-icon" aria-label="Remove">{{icon:x}}</button></div>
                      <div><button class="qa-add-step">{{icon:plus}}Add option</button></div>
                    </div>"""

SLIPBOX_CONTENT = (
    '---\ntitle: "' + P("title") + '"\naliases: ["' + P("title") + '"]\ncreated: "' + P("date") + '"\n'
    'tags: ["note/slipbox"]\n---\n\n# ' + P("title") + "\n\n## Description\n\n" + P("draft")
    + "\n\n## Original idea\n\n" + P("idea")
)

BOARDS = {
    # Draft Slipbox Note
    "StepAsk": dict(active=1, rail="_rail-slipbox.html", head=head("Draft Slipbox Note"), type="Ask me",
        inputs=pills([], BUILTINS) + FIRST,
        body="\n".join([
            row("Question", '<input type="text" value="Rough idea or observation:">', "Shown above the input box."),
            row("Multi-line", TOGGLE_ON, "A larger box. Enter adds a line, Cmd-Enter submits."),
        ]),
        out=out("idea", "what you typed · used by Opus, Haiku, Create file · click to rename")),
    "StepModel": dict(active=3, rail="_rail-slipbox.html", head=head("Draft Slipbox Note"), type="Ask a model",
        inputs=pills(["idea", "draft"], BUILTINS),
        body="\n".join([
            row("Model", '<select class="dropdown"><option>Haiku</option><option>Sonnet</option><option>Opus</option></select>'),
            stacked("System prompt", field("Generate a short title for a Zettelkasten note. Keep it under 8 words, no quotes, no trailing period.", "min-height: 64px;")),
            stacked("User prompt", field("Note body:\n" + P("draft") + "\n\nOriginal idea:\n" + P("idea"))),
        ]),
        out=out("title", "the reply · used by Create file")),
    "StepCreate": dict(active=4, rail="_rail-slipbox.html", head=head("Draft Slipbox Note"), type="Create file",
        inputs=pills(["idea", "draft", "title", "date", "timestamp"], ["time"]),
        body="\n".join([
            row("Path", field("Slipbox/" + P("timestamp") + " - " + P("title"), "width: 380px;"), ".md is added if missing."),
            stacked("Content", field(SLIPBOX_CONTENT, "min-height: 200px; font-family: var(--font-monospace); font-size: 12.5px;")),
        ]),
        out=out("note", "the file this step creates · used by Open file", file=True)),
    "StepOpen": dict(active=5, rail="_rail-slipbox.html", head=head("Draft Slipbox Note"), type="Open file",
        inputs=pills(["note"], ["idea", "draft", "title"] + BUILTINS, files=["note"]),
        body="\n".join([
            row("File", field(P("note", "is-file"), "width: 380px;"), "A file from an earlier step, or a path."),
            row("Scroll to", '<input type="text" value="## Description">', "A heading in the file. Leave empty for the top."),
        ]),
        out=out_none("nothing · this step only opens the file")),
    # Add to Log
    "StepPick": dict(active=1, rail="_rail-log.html", head=head("Add to Log"), type="Pick a file",
        inputs=pills([], BUILTINS) + FIRST,
        body=row("Folder", '<input type="text" value="Logs/">', "Only files in this folder are offered. Empty means the whole vault."),
        out=out("file", "the file you pick · used by Insert in section", file=True)),
    "StepInsert": dict(active=3, rail="_rail-log.html", head=head("Add to Log"), type="Insert in section",
        inputs=pills(["file", "description", "date", "time"], ["timestamp"], files=["file"]),
        body="\n".join([
            row("File", field(P("file", "is-file"), "width: 380px;"), "A file from an earlier step, or a path."),
            row("Section", '<input type="text" value="# Logs">', "The heading to insert under."),
            row("Position", '<select class="dropdown"><option>Beginning of section</option><option>End of section</option></select>'),
            stacked("Text", field("- " + P("date") + " (" + P("time") + "): " + P("description"), "min-height: 0;")),
            row("Create the file if missing", TOGGLE_OFF, "Off, so a mistyped path fails instead of making a stray file."),
        ]),
        out=out_none("nothing · this step writes to the file")),
    # Add Task to Task List
    "StepTasks": dict(active=2, rail="_rail-task.html", head=head("Add Task to Task List"), type="Tasks modal",
        inputs=pills(["file"], BUILTINS, files=["file"]),
        body=row("Opens the Tasks plugin dialog", "", "The task line it builds becomes this step's output. Nothing to configure. Needs the Tasks plugin."),
        out=out("task", "the task line · used by Insert in section")),
    # Choice, on an example action
    "StepChoice": dict(active=1, rail="_rail-choice.html", head=head("Log something"), type="Choice",
        inputs=pills([], BUILTINS) + FIRST,
        body="\n".join([
            row("Question", '<input type="text" value="Which log?">', "Shown above the list."),
            stacked("Options", OPTIONS),
        ]),
        out=out("where", "the option you pick, as text · used by Insert in section")),
    # Add step picker on a new, empty action
    "AddStep": dict(active=0, rail="_rail-new.html", head=head("New action"), type="", inputs="", body="", out=""),
}

for name, board in BOARDS.items():
    html = HEAD % board
    if name == "AddStep":
        html = re.sub(
            r'<div class="qa-pane" style="position: relative;">.*?</div>\n          </div>\n<!--INCLUDE:_editor-bottom',
            EMPTY_PANE, html, flags=re.S,
        )
    (HERE / f"{name}.src.html").write_text(html)
print("generated", ", ".join(BOARDS))
