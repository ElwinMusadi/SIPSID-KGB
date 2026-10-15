import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "Index.html");
const outputPath = resolve(root, "dist", "index.html");
const source = await readFile(sourcePath, "utf8");
const output = source;
// Guard against reintroducing legacy template/RPC markers or embedded credentials.
const forbidden = ["<?", "google.script.run", "isGasRuntime", "runGas(", "INITIAL_SERVER_DATA", "parseEmbeddedErrorMarker", "sipsid_session", "script.google.com/macros/s/", "const usersDatabase"];
for (const marker of forbidden) {
  if (output.includes(marker)) throw new Error(`Artifact Pages masih memuat marker terlarang: ${marker}`);
}

// Rebuild cleanly so no stale artifact or removed public asset is shipped.
await rm(dirname(outputPath), { recursive: true, force: true });
await mkdir(dirname(outputPath), { recursive: true });
await cp(resolve(root, "public"), dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`Cloudflare Pages artifact: ${outputPath}`);
