import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gasDir = resolve(root, "gas");
const files = ["Code.js", "Index.html", "appsscript.json"];

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
