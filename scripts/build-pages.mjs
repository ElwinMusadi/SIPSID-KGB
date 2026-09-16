import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "Index.html");
const outputPath = resolve(root, "dist", "index.html");
const gasTemplate = "<?!= serverData ?>";
const pagesBootstrap = JSON.stringify({ status: "success", gajiPNS: [], gajiPPPK: [], errorMsg: "" });

const source = await readFile(sourcePath, "utf8");
if (!source.includes(gasTemplate)) {
  throw new Error(`Template marker ${gasTemplate} tidak ditemukan pada Index.html.`);
}

const output = source.replace(gasTemplate, pagesBootstrap);
const forbidden = ["<?", "script.google.com/macros/s/", "const usersDatabase"];
for (const marker of forbidden) {
  if (output.includes(marker)) throw new Error(`Artifact Pages masih memuat marker terlarang: ${marker}`);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
const headers = await readFile(resolve(root, "public", "_headers"), "utf8");
await writeFile(resolve(root, "dist", "_headers"), headers, "utf8");
console.log(`Cloudflare Pages artifact: ${outputPath}`);
