const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hbb-handler-"));
process.env.LOG_LEVEL = "error";
const { deleteBackup, loadBackup } = require("../src/backupStore");
const { createInteractionHandler } = require("../src/handler");
const { fakeGuild, interactionFactory } = require("./fakes");

const ADMIN = "1002";
const OTHER_ADMIN = "1001";
const MEMBER = "1003";

async function setUp({ botPermissions, clock } = {}) {
  await deleteBackup("9000");
  const world = fakeGuild({
    botPermissions,
    members: [
      { id: "1001", nickname: "Boss", position: 10 },
      { id: "1002", nickname: "Ad", position: 3 },
      { id: "1003", nickname: null, position: 1 },
      { id: "1004", nickname: "Bobby", position: 1 },
    ],
  });
  const now = clock ? () => clock.t : Date.now;
  const handler = createInteractionHandler({ now, rollbackRetryDelaysMs: [1] });
  const discord = interactionFactory(world, { admins: [ADMIN, OTHER_ADMIN], now });
  return { world, handler, discord };
}

test("non-admins are refused and nothing changes", async () => {
  const { world, handler, discord } = await setUp();
  await handler.handle(discord.command(MEMBER, "setallback"));
  assert.match(discord.lastText(MEMBER), /administrators/);
  assert.equal(discord.buttonId("Confirm"), null);
  assert.equal(world.edits.length, 0);
});

test("a missing Manage Nicknames permission is reported up front", async () => {
  const { world, handler, discord } = await setUp({ botPermissions: 0n });
  await handler.handle(discord.command(ADMIN, "setallback"));
  assert.match(discord.lastText(), /Manage Nicknames/);
  assert.equal(discord.buttonId("Confirm"), null);
  assert.equal(world.edits.length, 0);
});

test("setallback asks first; cancel changes nothing", async () => {
  const { world, handler, discord } = await setUp();
  await handler.handle(discord.command(ADMIN, "setallback"));
  assert.match(discord.lastText(), /change 3 nicknames.*server owner/s);
  await handler.handle(discord.button(ADMIN, discord.buttonId("Cancel")));
  assert.match(discord.lastText(), /Cancelled/);
  assert.equal(world.edits.length, 0);
  assert.equal(handler.pendingActions.size, 0);
});

test("only the command author can confirm, and a double click runs once", async () => {
  const { world, handler, discord } = await setUp();
  await handler.handle(discord.command(ADMIN, "setallback"));
  const confirm = discord.buttonId("Confirm");

  await handler.handle(discord.button(OTHER_ADMIN, confirm));
  assert.match(discord.lastText(OTHER_ADMIN), /Only the person who ran the command/);
  assert.equal(world.edits.length, 0);

  await Promise.all([handler.handle(discord.button(ADMIN, confirm)), handler.handle(discord.button(ADMIN, confirm))]);
  assert.equal(world.successfulEdits("1002"), 1);
  assert.equal(world.successfulEdits("1003"), 1);
  assert.equal(world.nick("1001"), "Boss", "owner untouched");
  assert.ok(discord.responses.some((r) => /already used/.test(r.content)), "second click told it was used");
  assert.ok(discord.responses.some((r) => /Renamed 3 members/.test(r.content)));
});

test("a second admin's confirm is refused while a run is in progress in the guild", async () => {
  const { world, handler, discord } = await setUp();
  await handler.handle(discord.command(ADMIN, "setallback"));
  const first = discord.buttonId("Confirm");
  await handler.handle(discord.command(OTHER_ADMIN, "setallback"));
  const second = discord.buttonId("Confirm");

  await Promise.all([handler.handle(discord.button(ADMIN, first)), handler.handle(discord.button(OTHER_ADMIN, second))]);
  assert.match(discord.lastText(OTHER_ADMIN), /running in this server/);
  assert.equal(world.successfulEdits("1003"), 1);
  assert.equal(handler.busyGuilds.size, 0, "lock released after the run");
  assert.equal(handler.pendingActions.size, 1, "the refused confirmation can be retried");
});

test("expired confirmations are refused and pruned", async () => {
  const clock = { t: 1_000_000 };
  const { world, handler, discord } = await setUp({ clock });
  await handler.handle(discord.command(ADMIN, "setallback"));
  clock.t += 6 * 60 * 1000;
  await handler.handle(discord.button(ADMIN, discord.buttonId("Confirm")));
  assert.match(discord.lastText(), /expired/);
  assert.equal(world.edits.length, 0);
});

test("rollback restores after setallback, and reports a missing backup", async () => {
  const { world, handler, discord } = await setUp();
  await handler.handle(discord.command(ADMIN, "rollbackback"));
  assert.match(discord.lastText(), /No backup/);

  await handler.handle(discord.command(ADMIN, "setallback"));
  await handler.handle(discord.button(ADMIN, discord.buttonId("Confirm")));
  assert.equal(world.nick("1002"), "back");
  await handler.handle(discord.command(ADMIN, "rollbackback"));
  await handler.handle(discord.button(ADMIN, discord.buttonId("Confirm")));
  assert.match(discord.lastText(), /Restored 3 nicknames/);
  assert.equal(world.nick("1002"), "Ad");
  assert.equal(world.nick("1003"), null);
  assert.equal(await loadBackup("9000"), null);
});

test("long runs report progress, and the result goes by DM once the interaction token has expired", async () => {
  const clock = { t: 1_000_000 };
  const { world, handler, discord } = await setUp({ clock });
  const realEdit = world.guild.members.edit;
  world.guild.members.edit = async (...args) => {
    clock.t += 6 * 60 * 1000; // a very slow guild: six minutes per rename
    return realEdit(...args);
  };
  await handler.handle(discord.command(ADMIN, "setallback"));
  await handler.handle(discord.button(ADMIN, discord.buttonId("Confirm")));
  assert.ok(discord.responses.some((r) => r.kind === "editReply" && /Renaming: 1\/3/.test(r.content)));
  const dm = discord.responses.find((r) => r.kind === "dm");
  assert.match(dm?.content ?? "", /Renamed 3 members/);
});
