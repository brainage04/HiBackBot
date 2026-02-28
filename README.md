# About

Discord bot I made as part of a running joke between me and my friends (people would go afk -> come back and say "I'm back" -> people would say "hi back" as a funny dad joke)

Commands:
- `/setallback` asks for confirmation, then sets manageable member nicknames to `back`.
- `/rollbackback` asks for confirmation, then restores nicknames from the latest backup.

## Setup

1. Install dependencies:
```bash
npm install
```
2. Create env file:
```bash
cp .env.example .env
```
3. Fill in `.env`:
- `DISCORD_TOKEN`: bot token
- `CLIENT_ID`: application ID
- `GUILD_ID`: test server ID
- `LOG_LEVEL`: `error` | `warn` | `info` | `debug`
- `LOG_MEMBER_DETAILS`: `true` to log per-member filtering reasons for `/setallback`

## Invite Permissions

In the `Overview > Bot` tab, enable:
- `Server Members Intent`

## Register Commands

```bash
npm run deploy
```

## Start

```bash
npm start
```

## Notes

- "Manageable" members refers to members with a highest priority role lower than the bot's highest priority role. (Priority referring to the ordering of roles in the `People > Roles` tab in your server's `Server Settings`)
- Backups are stored at `data/backup-<guildId>.json`.
- `/rollbackback` restores only users listed in the latest backup file.
- Commands can only be used by server administrators (limited by command permissions, and runtime checks - just in case).
- If you are running this bot yourself and are troubleshooting, it may help to set `LOG_LEVEL=debug` and `LOG_MEMBER_DETAILS=true` for more detailed logs and member details respectively.
