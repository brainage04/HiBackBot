// Registers the slash commands: in GUILD_ID only when it is set (instant, for testing),
// otherwise globally for every server the bot is in.
const { REST, Routes } = require("discord.js");
const { commandDefinitions } = require("./commands");

const { DISCORD_TOKEN: token, CLIENT_ID: clientId, GUILD_ID: guildId } = process.env;

if (!token || !clientId) {
  console.error("Set DISCORD_TOKEN and CLIENT_ID (in .env or the environment). GUILD_ID is optional.");
  process.exit(1);
}

async function main() {
  const commands = commandDefinitions();
  const rest = new REST().setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`Deployed ${commands.length} commands ${guildId ? `to guild ${guildId}` : "globally"}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
