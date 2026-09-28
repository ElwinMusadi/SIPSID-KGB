import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("frontend memakai kontrak update yang sesuai untuk GAS dan Pages", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(
    html,
    /runGas\('apiUpdateLetter', sessionStorage\.getItem\('sipsid_session'\) \|\| '', id, payload\)/,
  );
  assert.match(
    html,
    /fetchJson\(`\/api\/letters\/\$\{encodeURIComponent\(id\)\}`, \{ method: 'PUT', body: JSON\.stringify\(payload\) \}\)/,
  );
  assert.match(html, /api\.updateLetter\(letterIdBeingEdited, formData\)/);
});

test("error update mengenali backend yang belum sinkron tanpa menutupi detail upstream", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /code === 'ACTION_NOT_FOUND'/);
  assert.match(html, /Aksi API tidak dikenal\|Script function not found:/);
  assert.match(html, /Deployment frontend dan backend belum sinkron/);
  assert.match(html, /Detail layanan: \$\{message\}/);
  assert.match(html, /getSubmitErrorMessage\(error, isEditing\)/);
});
