// Copies the built plugin into the vault and reloads it in the running Obsidian.
// The vault comes from $OBSIDIAN_VAULT, default ~/Obsidian. data.json stays in the vault.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const vault = process.env.OBSIDIAN_VAULT ?? join(homedir(), "Obsidian");
const { id } = JSON.parse(readFileSync("manifest.json", "utf8"));
const dest = join(vault, ".obsidian", "plugins", id);

mkdirSync(dest, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  if (existsSync(file)) copyFileSync(file, join(dest, file));
}
console.log(`Installed ${id} into ${dest}`);

if (process.argv.includes("--no-reload")) process.exit(0);
const reload = spawnSync("obsidian", [`plugin:reload`, `id=${id}`], { encoding: "utf8" });
if (reload.error) console.log("Obsidian CLI not found, reload it yourself");
else console.log((reload.stdout || reload.stderr).trim().split("\n").pop());
