# Dead Drop / Mailbox — Testing Brief

Status: **verified end-to-end on live Meshtastic hardware** (2026-06-18).

This note records how the Dead Drop / Mailbox feature was validated, what is
covered by automated tests, and the live over-the-air test results. User-facing
documentation lives in [`docs/features/automation.md` → Mailbox (Dead Drop)](../../features/automation.md#mailbox-dead-drop).

## What the feature is

An asynchronous, per-source message store ("mesh voicemail") exposed as a fifth
auto-responder `responseType: 'mailbox'`. A node DMs the radio `msg <name> <text>`;
MeshMonitor holds the message until the named recipient retrieves it with
`inbox` / `inbox play`. Implemented as a response type so it reuses the existing
auto-responder machinery (DM gating, per-node cooldown, parameter extraction,
message chunking, per-source scoping) rather than reinventing it.

## Architecture / files

| Layer | File |
|-------|------|
| Schema | `src/db/schema/deadDrop.ts` (`dead_drop_messages`, SQLite/PostgreSQL/MySQL, per-`sourceId`) |
| Migration | `src/server/migrations/NNN_create_dead_drop.ts` (registered in `src/db/migrations.ts`) |
| Repository | `src/db/repositories/deadDrop.ts` (Drizzle only) → `databaseService.deadDrop` |
| Service | `src/server/services/deadDropService.ts` (command parser/executor; repo injected for tests) |
| Integration | `src/server/meshtasticManager.ts` — `responseType === 'mailbox'` dispatch branch |
| Settings validation | `src/server/routes/settingsRoutes.ts` (accepts `mailbox`, no `response` required) |
| UI | `src/components/auto-responder/{types.ts,TriggerItem.tsx}`, `src/components/AutoResponderSection.tsx` |

Design notes:

- **Recipient matching** is by name as typed, resolved against the *requesting*
  node's identity forms (short/long name, `!hex`, node number) at retrieval time
  — the DM sender context proves identity, avoiding a brittle store-time lookup.
- **Soft state**: a row is pending until `playedAt`, hidden once `deletedAt`,
  and treated as expired when older than the cutoff (filtered from every read).
- **Command-prefix tolerance**: the service strips an optional prefix from the
  leading verb (`/^(\S*?)(msg|inbox)\b/i`), so a trigger configured with
  `betamsg`/`betainbox` can coexist with another responder already using bare
  `msg`/`inbox`. The trigger pattern is the source of truth for which messages
  reach the handler; the service parses leniently.

## Automated test coverage

Run: `npm run test:run` (Node 20+). Relevant suites:

- `src/db/migrations.test.ts` — registry count + ordering.
- `src/db/repositories/deadDrop.perSource.test.ts` — store/read/play/clear,
  per-recipient & per-sender caps, expiry filtering, **source isolation**.
- `src/server/services/deadDropService.test.ts` — full command brain: DM-only
  gate, store, multi-word body, byte limit, inbox summary/names, play (incl.
  batch cap + remainder), play-by-sender, delete (recipient-scoped), clear,
  node-id matching, caps, **keyword-prefix tolerance**.
- `src/server/routes/settingsRoutes.test.ts` — settings save accepts a mailbox
  trigger with empty `response` (200); non-mailbox empty response still 400;
  unknown `responseType` still 400.

## Live over-the-air test (2026-06-18)

Hardware: ALTO MF hosts the mailbox; ALTO LF (`ALLF`) and ZN Office (`ZNOF`) act
as clients. All traffic was **direct messages only** (no channel broadcasts).

Trigger on ALTO MF (beta keywords to coexist with the existing `msg`/`inbox`
prototype during the soak):

```
betamsg {recipient} {body:.+},betainbox,betainbox play {sender},betainbox play,betainbox delete {id},betainbox clear
```

| # | From → To | Sent | Reply observed |
|---|-----------|------|----------------|
| 1 | save via UI | add Mailbox trigger + Save | "Auto-responder settings saved" (the previously-failing path) |
| 2 | ALLF → ALMF | `betamsg ZNOF antenna mount loose` | `Stored for ZNOF (id 6458). Tell them to DM 'inbox'.` |
| 3 | ZNOF → ALMF | `betainbox` | `1 msg from 1 node (ALLF). Oldest: 1m ago. Reply 'inbox play ALLF'.` |
| 4 | ZNOF → ALMF | `betainbox play` | `MSG 1/1 from ALLF, 2m ago, id 6458` / `antenna mount loose` / `All 1 delivered. Reply 'inbox clear' to delete.` |
| 5 | ZNOF → ALMF | `betainbox clear` | `Cleared 1 played message.` |

Verified against the database at each step: `dead_drop_messages` row created
(recipient `znof`, sender `ALLF`, body exact) → `playedAt` set after play →
`deletedAt` set after clear. Server logs showed `📬 Auto-responder mailbox
completed` for each command, confirming the native `mailbox` dispatch path (not
the separate Python prototype, whose wording differs).

## Known limitation

In prefixed-keyword mode, the mailbox's reply hints suggest the **bare** verb
("Reply 'inbox play'") rather than the prefixed form, because the service is
prefix-unaware when composing hints. With the default `msg`/`inbox` keywords the
hints are exact. A future refinement could pass the configured prefix to the
service so hints echo it.

## Reproducing

1. Configure a Mailbox trigger as in [Configuration](../../features/automation.md#configuration).
2. From a second node, DM the host: `msg <yourname> hello`.
3. From the recipient node, DM the host: `inbox`, then `inbox play`.
4. Confirm rows in `dead_drop_messages` and `📬` lines in the server log.
