import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gasDir = resolve(root, "gas");
const executable = process.platform === "win32" ? "clasp.cmd" : "clasp";
const child = spawn(executable, ["push"], { cwd: gasDir, stdio: "inherit", shell: false });
child.on("error", error => {
  console.error(`Gagal menjalankan clasp: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", code => { process.exitCode = code ?? 1; });
