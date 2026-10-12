// A small offline stand-in for the parts of discord.js the bot uses. Members are plain objects;
// role positions decide who the bot can manage, like on Discord.
const { Collection, PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const BOT_ID = "100";

class FakeApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const unknownMember = () => new FakeApiError("Unknown Member", 10007, 404);
const serverError = () => new FakeApiError("Service Unavailable", 0, 503);

const role = (position) => ({ position, comparePositionTo: (other) => position - other.position });

/**
 * spec: { ownerId, botPermissions, members: [{ id, nickname, position, permissions }] }
 * Hooks: failEditIds (edits throw 403), fetchFailures (Map userId -> number of 503s before success).
 */
function fakeGuild({ ownerId = "1001", botPermissions = PermissionFlagsBits.ManageNicknames, botPosition = 5, members = [] } = {}) {
  const guild = { id: "9000", name: "Test Guild", ownerId, client: { user: { id: BOT_ID } } };
  const store = new Map();
  const makeMember = ({ id, nickname = null, position = 1, permissions = 0n }) => ({
    id,
    nickname,
    user: { id, username: `user${id}`, bot: id === BOT_ID },
    roles: { highest: role(position) },
    permissions: new PermissionsBitField(permissions),
  });
  for (const spec of [{ id: BOT_ID, position: botPosition, permissions: botPermissions }, ...members]) {
    store.set(spec.id, makeMember(spec));
  }

  const edits = [];
  const fetches = [];
  const failEditIds = new Set();
  const fetchFailures = new Map();
  guild.members = {
    get me() {
      return store.get(BOT_ID);
    },
    async fetchMe() {
      return store.get(BOT_ID);
    },
    async list({ limit, after }) {
      const sorted = [...store.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const page = sorted.filter((m) => !after || BigInt(m.id) > BigInt(after)).slice(0, limit);
      return new Collection(page.map((m) => [m.id, { ...m }]));
    },
    async fetch({ user }) {
      fetches.push(user);
      const remaining = fetchFailures.get(user) ?? 0;
      if (remaining > 0) {
        fetchFailures.set(user, remaining - 1);
        throw serverError();
      }
      const member = store.get(user);
      if (!member) throw unknownMember();
      return { ...member };
    },
    async edit(userId, { nick }) {
      await new Promise((resolve) => setImmediate(resolve)); // a real request yields
      const member = store.get(userId);
      const ok = !!member && !failEditIds.has(userId);
      edits.push({ userId, nick, ok });
      if (!member) throw unknownMember();
      if (!ok) throw new FakeApiError("Missing Permissions", 50013, 403);
      member.nickname = nick ?? null;
      return member;
    },
  };

  return {
    guild,
    edits,
    fetches,
    failEditIds,
    fetchFailures,
    nick: (id) => store.get(id)?.nickname,
    setNick: (id, nick) => (store.get(id).nickname = nick),
    addMember: (spec) => store.set(spec.id, makeMember(spec)),
    removeMember: (id) => store.delete(id),
    successfulEdits: (id) => edits.filter((e) => e.userId === id && e.ok).length,
  };
}

let interactionSeq = 0;

/** Records every response; `responses` is shared by all interactions of one test. */
function interactionFactory(world, { admins = ["1002"], now = Date.now } = {}) {
  const responses = [];
  function base(userId) {
    const record = (kind) => async (payload) => {
      const p = typeof payload === "string" ? { content: payload } : payload;
      responses.push({ kind, userId, interactionId: interaction.id, ...p });
      return p;
    };
    const interaction = {
      id: String(++interactionSeq),
      guild: world.guild,
      guildId: world.guild.id,
      user: { id: userId, username: `user${userId}`, send: record("dm") },
      memberPermissions: new PermissionsBitField(admins.includes(userId) ? PermissionFlagsBits.Administrator : 0n),
      createdTimestamp: now(),
      replied: false,
      deferred: false,
      inGuild: () => true,
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isButton: () => false,
      reply: async (p) => {
        interaction.replied = true;
        return record("reply")(p);
      },
      deferReply: async (p) => {
        interaction.deferred = true;
        return record("deferReply")(p);
      },
      update: async (p) => {
        interaction.replied = true;
        return record("update")(p);
      },
      editReply: async (p) => {
        if (interaction.editReplyFails) throw new FakeApiError("Invalid Webhook Token", 50027, 401);
        return record("editReply")(p);
      },
      followUp: record("followUp"),
    };
    return interaction;
  }

  return {
    responses,
    command(userId, commandName) {
      const interaction = base(userId);
      Object.assign(interaction, { commandName, isChatInputCommand: () => true });
      return interaction;
    },
    button(userId, customId) {
      const interaction = base(userId);
      Object.assign(interaction, { customId, isButton: () => true });
      return interaction;
    },
    /** customId of the given button in the latest response that has one. */
    buttonId(label) {
      for (const r of [...responses].reverse()) {
        for (const row of r.components ?? []) {
          const button = row.toJSON().components.find((c) => c.label === label);
          if (button) return button.custom_id;
        }
      }
      return null;
    },
    lastText: (userId) => responses.filter((r) => !userId || r.userId === userId).at(-1)?.content ?? "",
  };
}

module.exports = { BOT_ID, fakeGuild, interactionFactory, unknownMember, serverError };
