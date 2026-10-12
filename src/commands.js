// Slash command definitions, shared by the bot (names) and deploy-commands (full definitions).
const SETALLBACK = "setallback";
const ROLLBACKBACK = "rollbackback";

function commandDefinitions() {
  const { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
  return [
    new SlashCommandBuilder()
      .setName(SETALLBACK)
      .setDescription('Change every nickname the bot can manage to "back" (asks for confirmation).'),
    new SlashCommandBuilder()
      .setName(ROLLBACKBACK)
      .setDescription("Restore the nicknames changed by /setallback (asks for confirmation)."),
  ].map((command) =>
    command
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setContexts(InteractionContextType.Guild)
      .toJSON(),
  );
}

module.exports = { SETALLBACK, ROLLBACKBACK, commandDefinitions };
