// Pulls the subset of the obsidian-ui stylesheet (Obsidian's app.css remapped to .obsidian-app)
// that settings pages and modals use, so a .dc.html artboard can inline it.
import fs from "node:fs";
import postcss from "/home/matias/src/obsidian-design-system/node_modules/postcss/lib/postcss.mjs";

const [src, out] = process.argv.slice(2);
const root = postcss.parse(fs.readFileSync(src, "utf8"));

// Variable-defining blocks: the theme itself.
const rootRe = /^(\.obsidian-app|\.theme-(dark|light)|:root)(\.[\w-]+)*$/;
// Component classes the mockups use.
const specificRe =
  /\.(setting-item[\w-]*|setting-items|modal[\w-]*|vertical-tab[\w-]*|clickable-icon|svg-icon|dropdown|checkbox-container|multi-select[\w-]*|search-input[\w-]*|menu[\w-]*|tooltip[\w-]*|text-icon-button|styled-scrollbars)\b/;
// Generic tokens allowed alongside them; a selector that still names any other class is some
// other part of the app (bases, canvas, graph...) and is dropped.
const allowedRe =
  /\.(obsidian-app|theme-dark|theme-light|is-[\w-]+|mod-[\w-]+|has-[\w-]+|setting-item[\w-]*|setting-items|modal[\w-]*|vertical-tab[\w-]*|clickable-icon|svg-icon|dropdown|checkbox-container|multi-select[\w-]*|search-input[\w-]*|menu[\w-]*|tooltip[\w-]*|text-icon-button|styled-scrollbars)\b/g;
const elemRe = /(^|[\s>+~(,])(button|input|textarea|select|code|kbd|pre|label|hr|::selection|::placeholder|::-webkit-scrollbar[\w-]*)(\b|$)/;

function keepSelector(sel) {
  const s = sel.trim();
  if (rootRe.test(s)) return true;
  if (/\.[\w-]+/.test(s.replace(allowedRe, ""))) return false;
  return specificRe.test(s) || elemRe.test(s);
}

root.walkRules((rule) => {
  if (rule.parent?.type === "atrule" && /keyframes|font-face/.test(rule.parent.name)) return;
  const selectors = rule.selectors.filter(keepSelector);
  if (selectors.length === 0) rule.remove();
  else rule.selectors = selectors;
});
root.walkAtRules((at) => {
  if (/font-face|keyframes|import|charset/.test(at.name)) at.remove();
  else if (at.nodes && at.nodes.length === 0) at.remove();
});
root.walkComments((c) => c.remove());

fs.writeFileSync(out, root.toString());
console.log(`${out}: ${fs.statSync(out).size} bytes`);
