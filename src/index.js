const { Client, Events, GatewayIntentBits } = require("discord.js");
const { log, errorMeta } = require("./logger");
const { DATA_DIR } = require("./backupStore");
const { createInteractionHandler } = require("./handler");

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Set DISCORD_TOKEN (in .env or the environment).");
  process.exit(1);
}

// GuildMembers (the privileged Server Members intent) is required to list every member.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const handler = createInteractionHandler();

client.once(Events.ClientReady, (ready) => {
  log("info", "Bot ready", { user: ready.user.tag, guilds: ready.guilds.cache.size, dataDir: DATA_DIR });
});
client.on(Events.InteractionCreate, (interaction) => handler.handle(interaction));
client.on(Events.Error, (error) => log("error", "Discord client error", errorMeta(error)));

process.on("unhandledRejection", (reason) => log("error", "Unhandled promise rejection", errorMeta(reason)));
// After an uncaught exception the process is in an unknown state: log it and exit, and let the
// supervisor (systemd, pm2, Docker) restart the bot. Backups are on disk, so nothing is lost.
process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception, exiting", { ...errorMeta(error), stack: error?.stack });
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    log("info", `Received ${signal}, shutting down`);
    await client.destroy();
    process.exit(0);
  });
}

client.login(token);
