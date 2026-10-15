import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gasDir = resolve(root, "gas");
const files = ["Code.js", "Index.html", "appsscript.json"];

// Migration frontend no longer supports GAS. Validate BEFORE writing anything
// so an accidental build:gas cannot partially overwrite the rollback snapshot.
const template = await readFile(resolve(root, "Index.html"), "utf8");
if (!template.includes("<?!= serverData ?>")) {
  throw new Error("Build GAS dinonaktifkan pada frontend fetch-only. Gunakan tag pre-d1-cutover pada worktree terpisah untuk rollback GAS.");
}

await mkdir(gasDir, { recursive: true });
for (const name of files) {
  const source = resolve(root, name);
  const target = resolve(gasDir, name);
  if (name === "Index.html") {
    const html = await readFile(source, "utf8");
    if (!html.includes("<?!= serverData ?>")) throw new Error("Index.html bukan template GAS yang valid.");
    await writeFile(target, html, "utf8");
  } else {
    await copyFile(source, target);
  }
}
console.log(`Google Apps Script artifact: ${gasDir}`);
