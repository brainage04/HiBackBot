# HiBackBot review (October 2026)

Review of the original `c4ebd52` and what changed. The fixes are covered by the tests in `test/`
and were checked live on a real server (see the commit history).

## Bugs fixed, most serious first

1. **A second /setallback destroyed the first backup.** The backup file was overwritten with only
   the members renamed in the latest run. Everyone already "back" was skipped, so their original
   nicknames were gone. Runs are now merged into one backup. A member renamed again by a later run
   (because they renamed themselves in between) gets the nickname they had just before that run.
2. **Rollback overwrote nicknames changed since.** It restored every entry blindly. It now
   restores only members still called "back", leaves anyone who renamed themselves, and deletes the
   backup when everything is restored.
3. **Rollback could lose entries on a transient error** (also in the first draft of this fix).
   Every member-fetch error was treated as "member left". Now only Discord's Unknown Member (10007)
   drops an entry. Other errors are retried with a short backoff, and if they persist the entry is
   kept for the next /rollbackback and reported as "couldn't check". Failed restores are kept too.
4. **Double-clicking Confirm ran the action twice.** The pending action was deleted only after the
   run finished. It is now claimed before the first `await`.
5. **The backup was written only after all renames, non-atomically, and relative to the cwd.** A crash
   half-way lost every original nickname, and `npm start` from another directory used a different
   `data/`. The backup is now written before renaming and again afterwards, via temp file and
   rename, under the project's `data/` (or `DATA_DIR`).
6. **Failed renames were stored in the backup** and "restored" later. They are dropped.
7. **The first reply could miss Discord's 3-second deadline.** The member scan (one REST call per
   1000 members) ran before the reply, so a big guild got "The application did not respond". The
   command now defers first.
8. **Missing Manage Nicknames was discovered by failing every edit.** Both commands refuse up front
   with a message naming the permission, and the check repeats at Confirm.
9. **Stale targets.** The member list captured at command time was used up to 5 minutes later. The
   scan now reruns at Confirm.
10. **Expired confirmations were never pruned** from memory. They are pruned on every interaction.
11. **Logged errors could leak an interaction token.** discord.js REST errors carry the full URL,
    which for interaction replies is `/webhooks/<appId>/<interactionToken>/…`, and the logger
    printed it. URLs and every log line are now redacted (webhook/interaction tokens and anything
    shaped like a bot token).

## Risks addressed

- **Two admins at once.** A per-guild lock refuses a second Confirm while a run is in progress.
  The refused confirmation stays valid, so it can be retried.
- **Interaction token expiry.** The token lasts 15 minutes; renaming a few thousand members (about
  5 per second) takes longer. Progress is shown in the reply every 5 seconds while the token is
  valid, and after 14 minutes the final result is sent by DM. The run itself is not tied to the
  token, and the log always has the result.
- **`uncaughtException` was swallowed.** The bot kept running in an unknown state. It now logs and
  exits, and the supervisor restarts it. Unhandled rejections are still only logged; they come
  from individual REST calls and don't corrupt state.
- **Guild-only deployment.** `npm run deploy` deploys to `GUILD_ID` when set and globally otherwise.
  Commands are restricted to guilds (`setContexts(Guild)`) and default to Administrator.

## Other cleanup

- `index.js` (552 lines) is split into `handler.js` (interactions, confirmation, lock, reporting),
  `nicknames.js` (scan, rename and rollback, no interaction code), `commands.js` (definitions
  shared by the bot and the deploy script), `backupStore.js` and `logger.js`.
- The owner and members with a higher role are listed in the confirmation and the result ("Left
  alone: the server owner…"), instead of only as counts in the log.
- dotenv was replaced by Node's `--env-file-if-exists`. The only dependency is discord.js 14.27.0
  (latest stable; v15 is still in development). Node >= 22.12.
- `npm test` runs 23 offline tests (node:test plus a small fake of the discord.js surface).
- Live-tested on 2026-10-12 on a real server: cancel, confirm (double click ran once), the owner
  reported as left alone, second run, restart, rollback restoring the original (empty) nickname.

## Remaining limits

- Pending confirmations live in memory, so a restart invalidates open Confirm buttons (the bot says
  "expired"). The backup is on disk and survives restarts.
- The lock is per process. Running two instances of the bot with the same token isn't supported.
- Discord rate-limits nickname edits. discord.js queues and retries 429s, so big guilds are slow but
  correct.

## Recommendations for the next bot and a template

- **discord.js 14 (latest 14.x), on Node 24 LTS.** It is the most complete and best documented
  library. Use `Events.*`, `MessageFlags.Ephemeral` and `deferReply` everywhere. Watch v15, but
  don't start on its pre-releases. (Sapphire adds a framework on top; it isn't needed at this size.)
- **TypeScript for the template.** Most bugs here were about shapes and states (what an entry
  holds, which error code means what), which types catch. Use `tsc` for type checking and run with
  `node` (type stripping) or `tsx`, so there is no bundler. Keep this bot in JS; it is small and
  now tested.
- **One module per command** (`commands/<name>.ts` exporting `data` and `execute`, plus optional
  `buttons` handlers keyed by a customId prefix), loaded by both the bot and `deploy-commands`, so
  definitions can't drift. Keep Discord-free logic (like `nicknames.js`) separate so it can be tested
  without interactions.
- **Config and secrets:** Node `--env-file` locally, real environment variables or a systemd
  `EnvironmentFile`/credential in production. Validate at startup with a schema (zod) and fail fast.
  Keep the token in Bitwarden, never in the repo.
- **Persistence:** JSON files are fine for one small bot. For a template use SQLite
  (`node:sqlite`, built into Node 24 without a flag, or better-sqlite3) with one table per kind
  of state and transactions instead of rewrite-the-file.
- **Logging:** pino (levels, JSON, redaction of tokens) instead of the hand-written logger.
- **Testing:** node:test (or vitest with TypeScript) plus a small fake of the discord.js surface,
  as in `test/fakes.js`. Test logic modules directly and one handler test per flow.
- **Lint/format:** ESLint (flat config, typescript-eslint) and Prettier, or Biome for both in one
  tool. GitHub Actions running lint, type check and `npm test` on every push.
- **Deployment:** a systemd service (`Restart=on-failure`, `EnvironmentFile=`, a `StateDirectory=`
  for data) on the home server, or a small Docker image with a volume for `data/`. Commands are
  deployed by a separate step (`npm run deploy`), not on every start.
