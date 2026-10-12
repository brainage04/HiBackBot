const fs = require("node:fs/promises");
const path = require("node:path");

// Resolved against the project, not the shell's working directory, so `npm start` from anywhere
// finds the same backups. DATA_DIR overrides it (relative values are resolved against the cwd).
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));

function backupPath(guildId) {
  return path.join(DATA_DIR, `backup-${guildId}.json`);
}

/** Writes via a temp file and rename, so a crash mid-write never leaves a truncated backup. */
async function saveBackup(guildId, backup) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = backupPath(guildId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(backup, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/** Returns null when there is no backup. A corrupt file throws rather than being treated as empty. */
async function loadBackup(guildId) {
  try {
    return JSON.parse(await fs.readFile(backupPath(guildId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function deleteBackup(guildId) {
  await fs.rm(backupPath(guildId), { force: true });
}

/**
 * Adds the members renamed by a new run to an existing backup.
 * Members still called "back" are never targets of a new run, so they keep their original entry.
 * A member who IS a target again renamed themselves since the last run; the nickname they had just
 * before this run is the one to restore, so the newer entry wins.
 */
function mergeEntries(existing, added) {
  const byUser = new Map((existing ?? []).map((entry) => [entry.userId, entry]));
  for (const entry of added) byUser.set(entry.userId, entry);
  return [...byUser.values()];
}

module.exports = { DATA_DIR, saveBackup, loadBackup, deleteBackup, mergeEntries };
