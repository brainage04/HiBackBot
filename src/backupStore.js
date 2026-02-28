const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(process.cwd(), "data");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function backupPath(guildId) {
  return path.join(DATA_DIR, `backup-${guildId}.json`);
}

async function saveBackup(guildId, payload) {
  await ensureDir();
  const file = backupPath(guildId);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

async function loadBackup(guildId) {
  try {
    const file = backupPath(guildId);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

module.exports = {
  saveBackup,
  loadBackup,
};
