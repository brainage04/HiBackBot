# HiBackBot

Discord bot I made as part of a running joke between me and my friends (people would go AFK, come
back and say "I'm back", and people would say "hi back" as a dad joke).

## Commands

Both commands are for server administrators only, reply only to you (ephemeral), and change nothing
until you click **Confirm** within 5 minutes. Only the person who ran the command can click the buttons.

- `/setallback` renames every member the bot can manage to `back`. It tells you who it leaves alone:
  members already called `back`, the server owner (Discord never lets bots rename the owner) and
  members whose highest role is at or above the bot's. Each member's previous nickname is saved first.
- `/rollbackback` restores the saved nicknames, but only for members still called `back`. Anyone
  who renamed themselves since keeps their new name. Entries that couldn't be restored (Discord
  error) stay in the backup for the next `/rollbackback`; the backup is deleted once everything
  is restored.

Running `/setallback` again adds the newly renamed members to the same backup, so one
`/rollbackback` undoes all runs. Only one run at a time per server. On a big server the reply shows
progress; if a run takes longer than Discord's 14-minute window for the reply, the result is sent by DM.

## Setup

Requires Node.js 22.12 or later (24 LTS recommended).

1. In the [Developer Portal](https://discord.com/developers/applications), on the application's
   **Bot** page, enable **Server Members Intent** (the bot lists every member) and copy the token.
2. Install and configure:

   ```bash
   npm install
   cp .env.example .env   # then fill it in
   ```

   | Variable | Required | Meaning |
   |---|---|---|
   | `DISCORD_TOKEN` | yes | Bot token. Keep it secret (`.env` is gitignored). |
   | `CLIENT_ID` | for deploy | Application ID. |
   | `GUILD_ID` | no | Deploy commands to this server only (instant, for testing). Unset = global. |
   | `DATA_DIR` | no | Where backups are stored. Default: `data/` in the project. |
   | `LOG_LEVEL` | no | `error`, `warn`, `info` (default) or `debug`. |
   | `LOG_MEMBER_DETAILS` | no | `true` logs each member's scan decision (with `LOG_LEVEL=debug`). |

   Variables already set in the environment take precedence over `.env`.
3. Invite the bot with the `bot` and `applications.commands` scopes and the **Manage Nicknames**
   permission (`permissions=134217728`):

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=134217728
   ```

   Then, in **Server Settings → Roles**, drag the bot's role above every role whose members it
   should rename. It can only rename members whose highest role is below its own.
4. Register the slash commands, then start the bot:

   ```bash
   npm run deploy
   npm start
   ```

## Data

Backups are JSON files at `data/backup-<guildId>.json` (or under `DATA_DIR`), one per server,
written atomically. They hold user IDs, usernames and previous nicknames. Keep `data/` when moving
or redeploying the bot, or `/rollbackback` can't undo earlier runs.

## Running it permanently

Use a supervisor that restarts the bot: the bot exits on an unexpected error rather than keep
running in an unknown state. For example a systemd service with `Restart=on-failure`,
`WorkingDirectory=` set to the project and `ExecStart=/usr/bin/env npm start`.

## Development

```bash
npm test
```

The tests run offline against a small fake of discord.js (`test/fakes.js`). Code layout:
`src/index.js` (startup), `src/handler.js` (interactions, confirmation, per-server lock, progress),
`src/nicknames.js` (scan, rename, rollback), `src/backupStore.js`, `src/commands.js` (definitions,
shared with `src/deploy-commands.js`). See `REVIEW.md` for the code review and recommendations
for future bots.
