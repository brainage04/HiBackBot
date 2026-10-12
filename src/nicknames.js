// Guild-level work for /setallback and /rollbackback. Nothing here touches interactions, so the
// handler decides how to report progress and results.
const { log, errorMeta } = require("./logger");
const { deleteBackup, loadBackup, mergeEntries, saveBackup } = require("./backupStore");

const BACK = "back";
const PAGE_SIZE = 1_000;
const UNKNOWN_MEMBER = 10007; // RESTJSONErrorCodes.UnknownMember: the user is no longer in the guild
const LOG_MEMBER_DETAILS = /^(1|true|yes|on)$/i.test(process.env.LOG_MEMBER_DETAILS ?? "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why the bot can't rename this member, or null if it can (same rules as GuildMember#manageable). */
function skipReason(guild, member, me) {
  if (member.id === guild.ownerId) return "owner";
  if (member.id === guild.client.user.id) return "self";
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) return "roleHierarchy";
  return null;
}

/** Every member of the guild, one REST page at a time (needs the Server Members intent). */
async function* allMembers(guild) {
  let after;
  for (;;) {
    const page = await guild.members.list({ limit: PAGE_SIZE, after, cache: false });
    yield* page.values();
    if (page.size < PAGE_SIZE) return;
    after = page.lastKey();
  }
}

/** Members /setallback would rename, plus counts of everyone it would leave alone. */
async function scanTargets(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const entries = [];
  const stats = { seen: 0, alreadyBack: 0, owner: 0, self: 0, roleHierarchy: 0 };

  for await (const member of allMembers(guild)) {
    stats.seen += 1;
    const reason = member.nickname === BACK ? "alreadyBack" : skipReason(guild, member, me);
    if (LOG_MEMBER_DETAILS) log("debug", "Scanned member", { userId: member.id, username: member.user.username, skip: reason });
    if (reason) {
      stats[reason] += 1;
      continue;
    }
    entries.push({ userId: member.id, username: member.user.username, previousNickname: member.nickname ?? null });
  }

  log("info", "Scanned guild for /setallback", { guildId: guild.id, targets: entries.length, ...stats });
  return { entries, stats };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One line describing who a run leaves alone, for the confirmation and result messages. */
function describeSkipped(stats) {
  const parts = [];
  if (stats.alreadyBack) parts.push(`${plural(stats.alreadyBack, "member")} already "${BACK}"`);
  if (stats.owner) parts.push("the server owner (Discord never lets bots rename the owner)");
  if (stats.roleHierarchy) parts.push(`${plural(stats.roleHierarchy, "member")} with a role at or above mine`);
  return parts.length ? `Left alone: ${parts.join(", ")}.` : "";
}

/**
 * Renames every target to "back". The backup is written BEFORE the first rename, so a crash
 * half-way leaves every renamed member restorable, and rewritten afterwards without the failures.
 */
async function setAllBack(guild, requestedBy, targets, onProgress = () => {}) {
  const existing = await loadBackup(guild.id);
  const previous = existing?.entries ?? [];
  const backup = {
    guildId: guild.id,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: existing?.createdBy ?? requestedBy.id,
    entries: mergeEntries(previous, targets),
  };
  await saveBackup(guild.id, backup);

  const renamed = [];
  let failed = 0;
  for (const entry of targets) {
    try {
      await guild.members.edit(entry.userId, { nick: BACK, reason: `/setallback by ${requestedBy.username}` });
      renamed.push(entry);
    } catch (error) {
      failed += 1;
      log("warn", "Failed to rename member", { userId: entry.userId, error: errorMeta(error) });
    }
    await onProgress(renamed.length + failed, targets.length);
  }

  // A member we could not rename is not ours to restore.
  backup.entries = mergeEntries(previous, renamed);
  backup.updatedAt = new Date().toISOString();
  await saveBackup(guild.id, backup);
  log("info", "Finished /setallback", { guildId: guild.id, renamed: renamed.length, failed });
  return { renamed: renamed.length, failed };
}

/**
 * Fetches a member fresh from the API. Resolves null only when Discord says the member is gone
 * (Unknown Member); any other error is retried, then rethrown so the caller keeps the entry.
 */
async function fetchMember(guild, userId, retryDelaysMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await guild.members.fetch({ user: userId, force: true });
    } catch (error) {
      if (error?.code === UNKNOWN_MEMBER) return null;
      if (attempt >= retryDelaysMs.length) throw error;
      log("warn", "Member fetch failed, retrying", { userId, attempt: attempt + 1, error: errorMeta(error) });
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

/**
 * Restores nicknames from the backup. Only members still called "back" are touched: anyone who
 * renamed themselves since keeps their choice. Entries that could not be restored or checked stay
 * in the backup for the next rollback; the backup is deleted once nothing is left.
 * discord.js already retries 5xx responses itself; retryDelaysMs covers a slightly longer outage.
 */
async function rollback(guild, requestedBy, { onProgress = () => {}, retryDelaysMs = [250, 1_000] } = {}) {
  const backup = await loadBackup(guild.id);
  const entries = backup?.entries ?? [];
  const result = { restored: 0, renamedSince: 0, left: 0, failed: 0, unchecked: 0 };
  if (entries.length === 0) return { ...result, noBackup: true };

  const keep = [];
  for (const [index, entry] of entries.entries()) {
    try {
      const member = await fetchMember(guild, entry.userId, retryDelaysMs);
      if (!member) {
        result.left += 1;
      } else if (member.nickname !== BACK) {
        result.renamedSince += 1;
      } else {
        try {
          await guild.members.edit(entry.userId, {
            nick: entry.previousNickname ?? null,
            reason: `/rollbackback by ${requestedBy.username}`,
          });
          result.restored += 1;
        } catch (error) {
          result.failed += 1;
          keep.push(entry);
          log("warn", "Failed to restore nickname", { userId: entry.userId, error: errorMeta(error) });
        }
      }
    } catch (error) {
      result.unchecked += 1;
      keep.push(entry);
      log("warn", "Could not check member; keeping the backup entry", { userId: entry.userId, error: errorMeta(error) });
    }
    await onProgress(index + 1, entries.length);
  }

  if (keep.length > 0) {
    await saveBackup(guild.id, { ...backup, entries: keep, updatedAt: new Date().toISOString() });
  } else {
    await deleteBackup(guild.id);
  }
  log("info", "Finished /rollbackback", { guildId: guild.id, ...result });
  return result;
}

module.exports = { BACK, scanTargets, describeSkipped, setAllBack, rollback };
