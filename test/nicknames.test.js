const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hbb-nick-"));
process.env.LOG_LEVEL = "error";
const { loadBackup, deleteBackup } = require("../src/backupStore");
const { scanTargets, setAllBack, rollback, describeSkipped } = require("../src/nicknames");
const { fakeGuild } = require("./fakes");

const admin = { id: "1002", username: "adm" };
const members = () => [
  { id: "1001", nickname: "Boss", position: 10 }, // owner
  { id: "1002", nickname: "Ad", position: 3 },
  { id: "1003", nickname: null, position: 1 },
  { id: "1004", nickname: "Bobby", position: 1 },
  { id: "1005", nickname: "back", position: 1 }, // already back before the bot ran
  { id: "1006", nickname: "D", position: 7 }, // role above the bot's
];

async function setUp() {
  await deleteBackup("9000");
  return fakeGuild({ members: members() });
}

async function runSetAllBack(world) {
  const { entries } = await scanTargets(world.guild);
  return setAllBack(world.guild, admin, entries);
}

test("scan skips the owner, the bot, higher roles and members already 'back'", async () => {
  const world = await setUp();
  const { entries, stats } = await scanTargets(world.guild);
  assert.deepEqual(entries.map((e) => e.userId), ["1002", "1003", "1004"]);
  assert.deepEqual(stats, { seen: 7, alreadyBack: 1, owner: 1, self: 1, roleHierarchy: 1 });
  assert.match(describeSkipped(stats), /server owner/);
});

test("scan pages through more than 1000 members", async () => {
  const world = fakeGuild({ members: Array.from({ length: 2500 }, (_, i) => ({ id: String(2000 + i) })) });
  const { entries } = await scanTargets(world.guild);
  assert.equal(entries.length, 2500);
});

test("setallback saves a backup before the first rename and drops failed renames from it", async () => {
  const world = await setUp();
  world.failEditIds.add("1004");
  const { entries } = await scanTargets(world.guild);
  let backupDuringFirstEdit;
  const realEdit = world.guild.members.edit;
  world.guild.members.edit = async (...args) => {
    backupDuringFirstEdit ??= await loadBackup("9000");
    return realEdit(...args);
  };
  const result = await setAllBack(world.guild, admin, entries);
  assert.deepEqual(result, { renamed: 2, failed: 1 });
  assert.equal(backupDuringFirstEdit.entries.length, 3, "backup written before renaming");
  assert.deepEqual((await loadBackup("9000")).entries.map((e) => e.userId), ["1002", "1003"]);
  assert.equal(world.nick("1004"), "Bobby");
});

test("a second run keeps the first run's originals; rollback restores both runs", async () => {
  const world = await setUp();
  await runSetAllBack(world);
  world.addMember({ id: "1008", nickname: "G", position: 1 });
  await runSetAllBack(world);
  assert.equal(world.successfulEdits("1002"), 1, "second run must not rename again");

  const result = await rollback(world.guild, admin);
  assert.equal(result.restored, 4);
  assert.equal(world.nick("1002"), "Ad");
  assert.equal(world.nick("1003"), null, "a member without a nickname gets it cleared");
  assert.equal(world.nick("1004"), "Bobby");
  assert.equal(world.nick("1008"), "G");
  assert.equal(world.nick("1005"), "back", "was 'back' before the bot ran");
  assert.equal(await loadBackup("9000"), null, "backup deleted once everything is restored");
});

test("rollback leaves members who renamed themselves since", async () => {
  const world = await setUp();
  await runSetAllBack(world);
  world.setNick("1004", "Robert");
  const result = await rollback(world.guild, admin);
  assert.equal(world.nick("1004"), "Robert");
  assert.equal(result.renamedSince, 1);
  assert.equal(result.restored, 2);
});

test("rollback drops an entry only when Discord says Unknown Member (10007)", async () => {
  const world = await setUp();
  await runSetAllBack(world);
  world.removeMember("1003");
  const result = await rollback(world.guild, admin, { retryDelaysMs: [1] });
  assert.equal(result.left, 1);
  assert.equal(result.unchecked, 0);
  assert.equal(await loadBackup("9000"), null, "nothing kept for a member who left");
});

test("rollback retries a transient fetch error and then restores the member", async () => {
  const world = await setUp();
  await runSetAllBack(world);
  world.fetchFailures.set("1004", 1); // one 503, then success
  const result = await rollback(world.guild, admin, { retryDelaysMs: [1, 1] });
  assert.equal(world.nick("1004"), "Bobby");
  assert.equal(result.restored, 3);
  assert.equal(world.fetches.filter((id) => id === "1004").length, 2);
});

test("rollback keeps entries it couldn't check or restore, and a later rollback finishes them", async () => {
  const world = await setUp();
  await runSetAllBack(world);
  world.fetchFailures.set("1004", 10); // Discord keeps failing
  world.failEditIds.add("1003");
  const first = await rollback(world.guild, admin, { retryDelaysMs: [1, 1] });
  assert.equal(first.unchecked, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.restored, 1);
  assert.deepEqual((await loadBackup("9000")).entries.map((e) => e.userId).sort(), ["1003", "1004"]);

  world.fetchFailures.clear();
  world.failEditIds.clear();
  const second = await rollback(world.guild, admin, { retryDelaysMs: [1] });
  assert.equal(second.restored, 2);
  assert.equal(world.nick("1003"), null);
  assert.equal(world.nick("1004"), "Bobby");
  assert.equal(await loadBackup("9000"), null);
});

test("rollback without a backup reports it and edits nothing", async () => {
  const world = await setUp();
  const result = await rollback(world.guild, admin);
  assert.equal(result.noBackup, true);
  assert.equal(world.edits.length, 0);
});
