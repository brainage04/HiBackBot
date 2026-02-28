require("dotenv").config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { loadBackup, saveBackup } = require("./backupStore");

const token = process.env.DISCORD_TOKEN;
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const LOG_MEMBER_DETAILS = /^(1|true|yes|on)$/i.test(process.env.LOG_MEMBER_DETAILS ?? "");

if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const pendingActions = new Map();
const LOG_LEVEL_VALUE = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function nowMs() {
  return Date.now();
}

function newActionId(actionType, guildId, userId) {
  return `${actionType}:${guildId}:${userId}:${nowMs()}`;
}

function buildConfirmRow(actionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${actionId}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel:${actionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function ephemeralReply(content, extra = {}) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    ...extra,
  };
}

function shouldLog(level) {
  const current = LOG_LEVEL_VALUE[LOG_LEVEL] ?? LOG_LEVEL_VALUE.info;
  const requested = LOG_LEVEL_VALUE[level] ?? LOG_LEVEL_VALUE.info;
  return requested <= current;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(level, message, meta) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${message}`;
  const payload = meta ? `${line} ${safeJson(meta)}` : line;
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.log(payload);
}

function errorMeta(error) {
  if (!error) return { message: "Unknown error" };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    method: error.method,
    url: error.url,
    retry_after: error?.data?.retry_after,
    raw_message: error?.rawError?.message,
  };
}

function roleMeta(role) {
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    position: role.position,
  };
}

function manageabilityDiagnostics(guild, member, me) {
  if (member.id === guild.ownerId) {
    return { manageable: false, reason: "target_is_owner", compare: null };
  }
  if (member.id === guild.client.user.id) {
    return { manageable: false, reason: "target_is_bot_self", compare: null };
  }
  if (!me) {
    return { manageable: false, reason: "bot_member_missing", compare: null };
  }

  const myTopRole = me.roles?.highest;
  const theirTopRole = member.roles?.highest;
  if (!myTopRole || !theirTopRole) {
    return {
      manageable: false,
      reason: "missing_role_data",
      compare: null,
      myTopRole: roleMeta(myTopRole),
      theirTopRole: roleMeta(theirTopRole),
    };
  }

  const compare = myTopRole.comparePositionTo(theirTopRole);
  return {
    manageable: compare > 0,
    reason: compare > 0 ? "ok" : "role_hierarchy",
    compare,
    myTopRole: roleMeta(myTopRole),
    theirTopRole: roleMeta(theirTopRole),
  };
}

async function collectSetAllTargets(guild) {
  const entries = [];
  const stats = {
    pages: 0,
    seen: 0,
    eligible: 0,
    botsSeen: 0,
    alreadyBack: 0,
    notManageable: 0,
    notManageableReasons: {},
  };

  const me = guild.members.me ?? (await guild.members.fetchMe({ force: true }));
  const hasManageNicknames = me?.permissions?.has(PermissionFlagsBits.ManageNicknames) ?? false;

  log("info", "Scanning guild members for /setallback", {
    guildId: guild.id,
    guildName: guild.name,
    botUserId: guild.client.user.id,
    botMemberId: me?.id ?? null,
    hasManageNicknames,
    botTopRole: roleMeta(me?.roles?.highest),
  });

  if (!hasManageNicknames) {
    log("warn", "Bot is missing Manage Nicknames permission.");
  }

  let after;

  for (;;) {
    stats.pages += 1;
    const members = await guild.members.list({ limit: 1_000, after, cache: false });
    log("debug", "Fetched member page", {
      page: stats.pages,
      size: members.size,
      after: after ?? null,
    });

    if (members.size === 0) break;

    for (const member of members.values()) {
      stats.seen += 1;

      if (member.user.bot) {
        stats.botsSeen += 1;
      }

      if (member.nickname === "back") {
        stats.alreadyBack += 1;
        if (LOG_MEMBER_DETAILS) {
          log("debug", "Skipping member (already back)", {
            userId: member.id,
            username: member.user.username,
          });
        }
        continue;
      }

      const diag = manageabilityDiagnostics(guild, member, me);
      if (!diag.manageable) {
        stats.notManageable += 1;
        stats.notManageableReasons[diag.reason] = (stats.notManageableReasons[diag.reason] ?? 0) + 1;
        if (LOG_MEMBER_DETAILS) {
          log("debug", "Skipping member (not manageable)", {
            userId: member.id,
            username: member.user.username,
            reason: diag.reason,
            compare: diag.compare,
            botTopRole: diag.myTopRole,
            memberTopRole: diag.theirTopRole,
          });
        }
        continue;
      }

      entries.push({
        userId: member.id,
        username: member.user.username,
        previousNickname: member.nickname ?? null,
      });
      stats.eligible += 1;
      if (LOG_MEMBER_DETAILS) {
        log("debug", "Eligible member", {
          userId: member.id,
          username: member.user.username,
          previousNickname: member.nickname ?? null,
        });
      }
    }

    if (members.size < 1_000) break;
    after = members.lastKey();
  }

  log("info", "Finished scan for /setallback", stats);

  return { entries, stats };
}

async function runSetAllBack(interaction, entries, scanStats = null) {
  const targets = entries;

  if (targets.length === 0) {
    await interaction.editReply("No manageable members need nickname changes.");
    return;
  }

  log("info", "Running /setallback nickname updates", {
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    targetCount: targets.length,
    scanStats,
  });

  const backup = {
    createdAt: new Date().toISOString(),
    guildId: interaction.guild.id,
    createdBy: interaction.user.id,
    entries: targets,
  };

  let updated = 0;
  let failed = 0;

  for (const entry of targets) {
    try {
      await interaction.guild.members.edit(entry.userId, {
        nick: "back",
        reason: `Requested by ${interaction.user.tag}`,
      });
      updated += 1;
      log("debug", "Nickname updated", {
        userId: entry.userId,
        username: entry.username ?? null,
        updated,
        failed,
      });
    } catch (error) {
      failed += 1;
      log("warn", "Failed to update nickname", {
        userId: entry.userId,
        username: entry.username ?? null,
        previousNickname: entry.previousNickname ?? null,
        error: errorMeta(error),
      });
    }
  }

  if (failed > 0) {
    log("warn", "Some nickname updates failed.", {
      guildId: interaction.guild.id,
      requestedBy: interaction.user.id,
      targetCount: targets.length,
      updated,
      failed,
    });
  }

  await saveBackup(interaction.guild.id, backup);

  log("info", "Finished /setallback nickname updates", {
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    targetCount: targets.length,
    updated,
    failed,
    backupCreatedAt: backup.createdAt,
  });

  await interaction.editReply(
    `Finished /setallback. Updated: ${updated}, failed: ${failed}. Backup saved for /rollbackback.`,
  );
}

async function runRollback(interaction) {
  const backup = await loadBackup(interaction.guild.id);

  if (!backup || !Array.isArray(backup.entries) || backup.entries.length === 0) {
    await interaction.editReply("No backup found for this server.");
    return;
  }

  log("info", "Running /rollbackback nickname restore", {
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    backupCreatedAt: backup.createdAt,
    targetCount: backup.entries.length,
  });

  let restored = 0;
  let failed = 0;

  for (const entry of backup.entries) {
    try {
      await interaction.guild.members.edit(entry.userId, {
        nick: entry.previousNickname,
        reason: `Rollback requested by ${interaction.user.tag}`,
      });
      restored += 1;
      log("debug", "Nickname restored", {
        userId: entry.userId,
        restored,
        failed,
      });
    } catch (error) {
      failed += 1;
      log("warn", "Failed to restore nickname", {
        userId: entry.userId,
        previousNickname: entry.previousNickname ?? null,
        error: errorMeta(error),
      });
    }
  }

  log("info", "Finished /rollbackback nickname restore", {
    guildId: interaction.guild.id,
    requestedBy: interaction.user.id,
    backupCreatedAt: backup.createdAt,
    restored,
    failed,
  });

  await interaction.editReply(
    `Finished /rollbackback from backup created ${backup.createdAt}. Restored: ${restored}, failed: ${failed}.`,
  );
}

client.once("clientReady", () => {
  log("info", "Bot ready", {
    userTag: client.user.tag,
    userId: client.user.id,
    guildCount: client.guilds.cache.size,
    logLevel: LOG_LEVEL,
    logMemberDetails: LOG_MEMBER_DETAILS,
  });
});

client.on("error", (error) => {
  log("error", "Discord client error", errorMeta(error));
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection", {
    reason: errorMeta(reason),
  });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception", errorMeta(error));
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return;

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply(ephemeralReply("Admins only."));
        return;
      }

      log("info", "Slash command received", {
        commandName: interaction.commandName,
        guildId: interaction.guild.id,
        guildName: interaction.guild.name,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      if (interaction.commandName === "setallback") {
        const { entries: targets, stats } = await collectSetAllTargets(interaction.guild);

        if (targets.length === 0) {
          await interaction.reply(
            ephemeralReply(
              `No manageable members need nickname changes. Seen: ${stats.seen}, bots seen: ${stats.botsSeen}, already back: ${stats.alreadyBack}, not manageable: ${stats.notManageable}.`,
            ),
          );
          return;
        }

        const actionId = newActionId("setallback", interaction.guild.id, interaction.user.id);
        pendingActions.set(actionId, {
          actionType: "setallback",
          guildId: interaction.guild.id,
          userId: interaction.user.id,
          createdAtMs: nowMs(),
          entries: targets,
          scanStats: stats,
        });

        await interaction.reply(
          ephemeralReply(
            `This will change ${targets.length} nicknames to "back". Seen: ${stats.seen}, bots seen: ${stats.botsSeen}, already back: ${stats.alreadyBack}, not manageable: ${stats.notManageable}. Confirm?`,
            {
              components: [buildConfirmRow(actionId)],
            },
          ),
        );
        return;
      }

      if (interaction.commandName === "rollbackback") {
        const backup = await loadBackup(interaction.guild.id);

        if (!backup || !Array.isArray(backup.entries) || backup.entries.length === 0) {
          await interaction.reply(ephemeralReply("No backup found for this server."));
          return;
        }

        const actionId = newActionId("rollbackback", interaction.guild.id, interaction.user.id);
        pendingActions.set(actionId, {
          actionType: "rollbackback",
          guildId: interaction.guild.id,
          userId: interaction.user.id,
          createdAtMs: nowMs(),
        });

        await interaction.reply(
          ephemeralReply(
            `This will attempt to restore ${backup.entries.length} nicknames from backup created ${backup.createdAt}. Confirm?`,
            {
              components: [buildConfirmRow(actionId)],
            },
          ),
        );
      }
    }

    if (!interaction.isButton()) return;
    if (!interaction.inGuild()) return;

    const separatorIndex = interaction.customId.indexOf(":");
    if (separatorIndex === -1) return;

    const intent = interaction.customId.slice(0, separatorIndex);
    const actionId = interaction.customId.slice(separatorIndex + 1);
    if (!intent || !actionId) return;

    const action = pendingActions.get(actionId);
    if (!action) {
      await interaction.reply(ephemeralReply("This confirmation has expired."));
      return;
    }

    if (interaction.user.id !== action.userId) {
      await interaction.reply(ephemeralReply("Only the command author can confirm this action."));
      return;
    }

    if (interaction.guild.id !== action.guildId) {
      await interaction.reply(ephemeralReply("Server mismatch for this action."));
      return;
    }

    if (nowMs() - action.createdAtMs > 5 * 60 * 1000) {
      pendingActions.delete(actionId);
      await interaction.update({ content: "This confirmation timed out.", components: [] });
      return;
    }

    if (intent === "cancel") {
      pendingActions.delete(actionId);
      await interaction.update({ content: "Action canceled.", components: [] });
      return;
    }

    if (intent === "confirm") {
      await interaction.update({ content: "Running action...", components: [] });

      try {
        if (action.actionType === "setallback") {
          await runSetAllBack(interaction, action.entries ?? [], action.scanStats ?? null);
        } else if (action.actionType === "rollbackback") {
          await runRollback(interaction);
        } else {
          await interaction.editReply("Unknown action.");
        }
      } finally {
        pendingActions.delete(actionId);
      }
    }
  } catch (error) {
    log("error", "Interaction handler error", {
      error: errorMeta(error),
      interactionType: interaction.type,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : null,
      customId: interaction.isButton() ? interaction.customId : null,
      guildId: interaction.guildId ?? null,
      userId: interaction.user?.id ?? null,
    });
    if (!interaction.isRepliable()) return;
    const payload = ephemeralReply("Action failed. Check bot logs and permissions.");
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(token);
