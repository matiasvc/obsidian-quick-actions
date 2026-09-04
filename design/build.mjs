// Assembles the design artboards: every `<Name>.src.html` becomes `out/<Name>.dc.html` with the
// Obsidian stylesheet subset inlined where the source says `<!--OBSIDIAN_CSS-->` and every
// `{{icon:name}}` replaced by that Lucide icon as Obsidian renders it (an inline `.svg-icon`).
//
//   node build.mjs            # build all
//   node build.mjs Main       # build one
//
// Regenerate obsidian-subset.css after a design-system update with:
//   node extract-css.mjs ~/src/obsidian-design-system/dist/obsidian-ui.css obsidian-subset.css
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const LUCIDE = "/home/matias/src/obsidian-design-system/node_modules/lucide-react/dist/esm/icons";

const css = fs.readFileSync(path.join(here, "obsidian-subset.css"), "utf8");
// The design system's shim: anchor Obsidian's fixed overlays to the wrapper instead of the page.
const shim = `
.obsidian-app { position: relative; contain: initial; height: auto; width: auto; overflow: visible; }
.obsidian-app .modal-container, .obsidian-app .notice-container { position: absolute; }
`;

const iconCache = new Map();
function icon(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  const file = path.join(LUCIDE, `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`No Lucide icon "${name}"`);
  const src = fs.readFileSync(file, "utf8");
  const m = /__iconNode = (\[[\s\S]*?\]);\n/.exec(src);
  if (!m) throw new Error(`Cannot parse icon "${name}"`);
  const nodes = new Function(`return ${m[1]}`)();
  const inner = nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}></${tag}>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${name}">${inner}</svg>`;
  iconCache.set(name, svg);
  return svg;
}

const only = process.argv[2];
const sources = fs.readdirSync(here).filter((f) => f.endsWith(".src.html") && (!only || f === `${only}.src.html`));
fs.mkdirSync(path.join(here, "out"), { recursive: true });
for (const file of sources) {
  const name = file.replace(/\.src\.html$/, "");
  let html = fs.readFileSync(path.join(here, file), "utf8");
  // `<!--INCLUDE:_partial.html-->` pastes a shared fragment (frames, custom chrome CSS). Partials
  // may include partials, so repeat until nothing is left to expand.
  const includeRe = /<!--INCLUDE:([\w.-]+)-->/g;
  for (let depth = 0; includeRe.test(html) && depth < 8; depth++) {
    html = html.replace(includeRe, (_, f) => fs.readFileSync(path.join(here, f), "utf8"));
  }
  html = html.replace("<!--OBSIDIAN_CSS-->", () => css + shim);
  html = html.replace(/\{\{icon:([\w-]+)\}\}/g, (_, n) => icon(n));
  const out = path.join(here, "out", `${name}.dc.html`);
  fs.writeFileSync(out, html);
  console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
