// interactionCreate handling: admin and permission checks, the Confirm/Cancel step, a per-guild
// lock, and progress/result reporting for runs that may outlive the interaction token.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } = require("discord.js");
const { log, errorMeta } = require("./logger");
const { loadBackup } = require("./backupStore");
const { BACK, describeSkipped, rollback, scanTargets, setAllBack } = require("./nicknames");
const { ROLLBACKBACK, SETALLBACK } = require("./commands");

const MISSING_PERMISSION = 'I need the "Manage Nicknames" permission to do this. Ask a server admin to grant it to my role.';

function ephemeral(content, extra = {}) {
  return { content, flags: MessageFlags.Ephemeral, ...extra };
}

function confirmRow(actionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${actionId}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancel:${actionId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

async function canManageNicknames(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  return me.permissions.has(PermissionFlagsBits.ManageNicknames);
}

/**
 * Edits the ephemeral reply while the interaction token is valid (15 minutes from the click), at most
 * once per progressIntervalMs. After that the result is sent to the user by DM.
 */
function createReporter(interaction, { now, progressIntervalMs, tokenLifetimeMs }) {
  const tokenExpiresAt = interaction.createdTimestamp + tokenLifetimeMs;
  let tokenUsable = true;
  let lastProgressAt = now();

  async function edit(content) {
    if (!tokenUsable || now() >= tokenExpiresAt) {
      tokenUsable = false;
      return false;
    }
    try {
      await interaction.editReply({ content, components: [] });
      return true;
    } catch (error) {
      tokenUsable = false;
      log("warn", "Could not edit the interaction reply", errorMeta(error));
      return false;
    }
  }

  return {
    async progress(label, done, total) {
      if (done >= total || now() - lastProgressAt < progressIntervalMs) return;
      lastProgressAt = now();
      await edit(`${label}: ${done}/${total}…`);
    },
    async finish(content) {
      if (await edit(content)) return;
      await interaction.user
        .send(`${content}\n(${interaction.guild.name}; the original reply had expired.)`)
        .catch((error) => log("warn", "Could not DM the result either", errorMeta(error)));
    },
  };
}

function createInteractionHandler({
  now = Date.now,
  confirmTtlMs = 5 * 60 * 1000,
  progressIntervalMs = 5_000,
  tokenLifetimeMs = 14 * 60 * 1000, // Discord allows 15; keep a margin
  rollbackRetryDelaysMs,
} = {}) {
  const pendingActions = new Map(); // actionId -> { actionType, guildId, userId, createdAtMs }
  const busyGuilds = new Set(); // guilds with a run in progress
  let sequence = 0;

  function pruneExpired() {
    for (const [id, action] of pendingActions) {
      if (now() - action.createdAtMs > confirmTtlMs) pendingActions.delete(id);
    }
  }

  function addPending(actionType, interaction) {
    const actionId = `${actionType}:${interaction.guildId}:${interaction.user.id}:${now()}:${++sequence}`;
    pendingActions.set(actionId, { actionType, guildId: interaction.guildId, userId: interaction.user.id, createdAtMs: now() });
    return actionId;
  }

  async function handleCommand(interaction) {
    if (interaction.commandName !== SETALLBACK && interaction.commandName !== ROLLBACKBACK) return;
    if (!interaction.inGuild()) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply(ephemeral("Only server administrators can use this command."));
      return;
    }
    log("info", "Slash command", { command: interaction.commandName, guildId: interaction.guildId, userId: interaction.user.id });
    if (!(await canManageNicknames(interaction.guild))) {
      await interaction.reply(ephemeral(MISSING_PERMISSION));
      return;
    }
    // Scanning a big guild takes longer than the 3 seconds Discord gives for the first response.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (interaction.commandName === SETALLBACK) {
      const { entries, stats } = await scanTargets(interaction.guild);
      const skipped = describeSkipped(stats);
      if (entries.length === 0) {
        await interaction.editReply(`Nobody needs renaming. ${skipped}`.trim());
        return;
      }
      const actionId = addPending(SETALLBACK, interaction);
      await interaction.editReply({
        content: `This will change ${entries.length} nickname${entries.length === 1 ? "" : "s"} to "${BACK}". ${skipped}\nConfirm within 5 minutes?`,
        components: [confirmRow(actionId)],
      });
      return;
    }

    const backup = await loadBackup(interaction.guildId);
    if (!backup?.entries?.length) {
      await interaction.editReply("No backup found for this server, so there is nothing to roll back.");
      return;
    }
    const actionId = addPending(ROLLBACKBACK, interaction);
    await interaction.editReply({
      content: `This will restore the original nicknames of ${backup.entries.length} member${backup.entries.length === 1 ? "" : "s"} who are still called "${BACK}" (backup from ${backup.createdAt}). Confirm within 5 minutes?`,
      components: [confirmRow(actionId)],
    });
  }

  async function handleButton(interaction) {
    const separator = interaction.customId.indexOf(":");
    const intent = interaction.customId.slice(0, separator);
    const actionId = interaction.customId.slice(separator + 1);
    if (separator === -1 || (intent !== "confirm" && intent !== "cancel")) return;

    const action = pendingActions.get(actionId);
    if (!action) {
      await interaction.reply(ephemeral("This confirmation has expired or was already used. Run the command again."));
      return;
    }
    if (interaction.user.id !== action.userId || interaction.guildId !== action.guildId) {
      await interaction.reply(ephemeral("Only the person who ran the command can use these buttons."));
      return;
    }
    if (now() - action.createdAtMs > confirmTtlMs) {
      pendingActions.delete(actionId);
      await interaction.update({ content: "This confirmation timed out. Nothing was changed.", components: [] });
      return;
    }
    if (intent === "cancel") {
      pendingActions.delete(actionId);
      await interaction.update({ content: "Cancelled. Nothing was changed.", components: [] });
      return;
    }
    if (busyGuilds.has(action.guildId)) {
      await interaction.reply(ephemeral("Another /setallback or /rollbackback is running in this server. Try again when it finishes."));
      return;
    }

    // Claim the action and lock the guild before the first await, so a double click or a second
    // admin cannot start a parallel run.
    pendingActions.delete(actionId);
    busyGuilds.add(action.guildId);
    try {
      await interaction.update({ content: "Working…", components: [] });
      const reporter = createReporter(interaction, { now, progressIntervalMs, tokenLifetimeMs });
      if (!(await canManageNicknames(interaction.guild))) {
        await reporter.finish(MISSING_PERMISSION);
        return;
      }
      if (action.actionType === SETALLBACK) {
        // Rescan: nicknames and members may have changed while the confirmation was open.
        const { entries, stats } = await scanTargets(interaction.guild);
        const { renamed, failed } = await setAllBack(interaction.guild, interaction.user, entries, (done, total) =>
          reporter.progress("Renaming", done, total),
        );
        await reporter.finish(
          `Done. Renamed ${renamed} member${renamed === 1 ? "" : "s"} to "${BACK}"${failed ? `, ${failed} failed (see the bot log)` : ""}. ${describeSkipped(stats)}\nUse /rollbackback to undo.`,
        );
      } else {
        const result = await rollback(interaction.guild, interaction.user, {
          onProgress: (done, total) => reporter.progress("Restoring", done, total),
          retryDelaysMs: rollbackRetryDelaysMs,
        });
        await reporter.finish(describeRollback(result));
      }
    } finally {
      busyGuilds.delete(action.guildId);
    }
  }

  async function handle(interaction) {
    try {
      pruneExpired();
      if (interaction.isChatInputCommand()) await handleCommand(interaction);
      else if (interaction.isButton() && interaction.inGuild()) await handleButton(interaction);
    } catch (error) {
      log("error", "Interaction failed", {
        error: errorMeta(error),
        command: interaction.isChatInputCommand() ? interaction.commandName : null,
        customId: interaction.isButton() ? interaction.customId : null,
        guildId: interaction.guildId ?? null,
        userId: interaction.user?.id ?? null,
      });
      if (!interaction.isRepliable()) return;
      const payload = ephemeral("Something went wrong. Check the bot log.");
      const send = interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
      await send.catch(() => {});
    }
  }

  return { handle, pendingActions, busyGuilds };
}

function describeRollback({ noBackup, restored, renamedSince, left, failed, unchecked }) {
  if (noBackup) return "No backup found for this server, so there is nothing to roll back.";
  const lines = [`Done. Restored ${restored} nickname${restored === 1 ? "" : "s"}.`];
  if (renamedSince) lines.push(`Left alone: ${renamedSince} who changed their nickname since /setallback.`);
  if (left) lines.push(`Dropped: ${left} who left the server.`);
  if (failed || unchecked) {
    lines.push(`Kept in the backup for the next /rollbackback: ${failed} that failed to restore, ${unchecked} I couldn't check (Discord error).`);
  }
  return lines.join("\n");
}

module.exports = { createInteractionHandler, describeRollback };
