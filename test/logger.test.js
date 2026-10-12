const test = require("node:test");
const assert = require("node:assert/strict");
const { DiscordAPIError } = require("discord.js");
const { log, errorMeta } = require("../src/logger");

const INTERACTION_TOKEN = "aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4OTpzZWNyZXRzZWNyZXRzZWNyZXQ";
// Fake, built at runtime so secret scanners don't flag a token-shaped literal.
const BOT_TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "AbCdEf", "x".repeat(38)].join(".");

function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (line) => lines.push(line);
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

test("a failed editReply never logs the interaction token from the webhook URL", () => {
  const url = `https://discord.com/api/v10/webhooks/1477249793578242068/${INTERACTION_TOKEN}/messages/@original`;
  const error = new DiscordAPIError({ code: 50027, message: "Invalid Webhook Token" }, 50027, 401, "PATCH", url, {
    body: { content: "x" },
  });
  const output = captureLogs(() => {
    log("warn", "Could not edit the interaction reply", errorMeta(error));
    log("error", "Uncaught exception", { ...errorMeta(error), stack: `${error.stack}\n    at ${url}` });
  });
  assert.doesNotMatch(output, new RegExp(INTERACTION_TOKEN));
  assert.match(output, /webhooks\/1477249793578242068\/\[REDACTED\]/, "keeps the route for debugging");
  assert.match(output, /Invalid Webhook Token/);
});

test("a bot token in any logged text is redacted", () => {
  const output = captureLogs(() => log("error", `login failed for ${BOT_TOKEN}`, { reason: `token ${BOT_TOKEN}` }));
  assert.doesNotMatch(output, new RegExp(BOT_TOKEN.replace(/\./g, "\\.")));
});
