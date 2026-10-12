const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(level, message, meta) {
  if ((LEVELS[level] ?? LEVELS.info) > configured) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const payload = meta ? `${line} ${safeJson(meta)}` : line;
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/** The fields of a discord.js/REST error worth logging; never the request body. */
function errorMeta(error) {
  if (!error) return { message: "Unknown error" };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    method: error.method,
    url: error.url,
  };
}

module.exports = { log, errorMeta };
