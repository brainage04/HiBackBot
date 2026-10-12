const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? LEVELS.info;

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Interaction tokens are part of webhook URLs (/webhooks/<appId>/<token>, /interactions/<id>/<token>),
// and discord.js REST errors carry the full URL. Bot tokens look like <base64 id>.<ts>.<hmac>.
const SECRET_PATTERNS = [
  [/\/(webhooks|interactions)\/(\d+)\/[^/?\s"]+/g, "/$1/$2/[REDACTED]"],
  [/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g, "[REDACTED]"],
];

function redact(text) {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function log(level, message, meta) {
  if ((LEVELS[level] ?? LEVELS.info) > configured) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const payload = redact(meta ? `${line} ${safeJson(meta)}` : line);
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/** The fields of a discord.js/REST error worth logging: never the request body, and no tokens. */
function errorMeta(error) {
  if (!error) return { message: "Unknown error" };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    method: error.method,
    url: typeof error.url === "string" ? redact(error.url) : undefined,
  };
}

module.exports = { log, errorMeta, redact };
