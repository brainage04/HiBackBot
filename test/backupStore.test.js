const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hbb-store-"));
const { DATA_DIR, saveBackup, loadBackup, deleteBackup, mergeEntries } = require("../src/backupStore");

test("merge keeps entries of members not renamed again and adds new ones", () => {
  const first = [
    { userId: "1", previousNickname: "Alice" },
    { userId: "2", previousNickname: null },
  ];
  const second = [{ userId: "3", previousNickname: "Gina" }];
  assert.deepEqual(mergeEntries(first, second), [...first, ...second]);
});

test("merge prefers the newer entry for a member who renamed themselves between runs", () => {
  const first = [{ userId: "1", previousNickname: "Alice" }];
  const second = [{ userId: "1", previousNickname: "Al" }];
  assert.deepEqual(mergeEntries(first, second), second);
});

test("backups round-trip atomically and can be deleted", async () => {
  assert.equal(await loadBackup("g"), null);
  await saveBackup("g", { entries: [{ userId: "1", previousNickname: null }] });
  assert.deepEqual((await loadBackup("g")).entries, [{ userId: "1", previousNickname: null }]);
  assert.deepEqual(fs.readdirSync(DATA_DIR), ["backup-g.json"], "no temp files left behind");
  await deleteBackup("g");
  assert.equal(await loadBackup("g"), null);
});

test("a corrupt backup throws instead of looking empty", async () => {
  fs.writeFileSync(path.join(DATA_DIR, "backup-bad.json"), "{ truncated");
  await assert.rejects(loadBackup("bad"), SyntaxError);
});
