# Auto-Acknowledge 2×2 matrix (discussion #3564)

Replace the tangled hop-based scheme (where "Direct" actually meant 0-hop and
tapback/reply toggles were keyed only on hop distance, shared across channel &
DM) with a clean **message-type × hop-distance** matrix.

## The 4 cells
`{ Channel, Direct } × { ZeroHop, MultiHop }`

Cell ids: `ChannelZeroHop`, `ChannelMultiHop`, `DirectZeroHop`, `DirectMultiHop`.

## Per-cell config (3 toggles)
- **Reply** (send the message template) — key `autoAck{Cell}ReplyEnabled`
- **Tapback** (send the hop-count emoji reaction) — key `autoAck{Cell}TapbackEnabled`
- **Respond via DM** — key `autoAck{Cell}ReplyDmEnabled`
  - Applies to the **Reply only** (tapback-via-DM is unreliable). UI: the
    "Respond via DM" checkbox is disabled unless Reply is checked.
  - For Channel cells: routes the reply as a DM to the sender instead of
    on-channel. For Direct cells: replies are inherently DMs, so the flag is a
    no-op (UI shows it disabled/checked for honesty).

→ 12 new per-source setting keys.

## Retained global keys
`autoAckEnabled`, `autoAckRegex`, `autoAckMessage`, `autoAckMessageDirect`,
`autoAckChannels` (which channels are eligible — gates the two Channel cells),
`autoAckSkipIncompleteNodes`, `autoAckIgnoredNodes`, `autoAckCooldownSeconds`,
`autoAckTestMessages`.

## Deprecated keys (migrated, then ignored)
`autoAckDirectMessages`, `autoAckUseDM`, `autoAckTapbackEnabled`,
`autoAckReplyEnabled`, `autoAckDirectEnabled`, `autoAckDirectTapbackEnabled`,
`autoAckDirectReplyEnabled`, `autoAckMultihopEnabled`,
`autoAckMultihopTapbackEnabled`, `autoAckMultihopReplyEnabled`.

## Migration (preserve existing behavior, per-source)
Old `autoAckDirect*` = ZeroHop behavior; `autoAckMultihop*` = MultiHop behavior.
DM type was gated by `autoAckDirectMessages`; channel reply routing by global
`autoAckUseDM`.

For each source (and global):
- `ChannelZeroHop.Reply`   = directReplyEnabled && directEnabled (default true)
- `ChannelZeroHop.Tapback` = directTapbackEnabled && directEnabled
- `ChannelMultiHop.*`       = multihop* && multihopEnabled
- `Direct*.Reply/Tapback`   = same as the Channel row of the same hop, but the
  whole Direct column is OFF unless `autoAckDirectMessages === true`
- `Channel*.ReplyDm`        = autoAckUseDM
- `Direct*.ReplyDm`         = true (inherent)

## Decision logic (server `checkAutoAcknowledge`)
1. type = isDirectMessage ? Direct : Channel
2. hop  = (hopsTraveled === 0 && !viaMqtt) ? ZeroHop : MultiHop
3. Channel type still gated by `autoAckChannels` allowlist; Direct type active
   iff the Direct cells have anything enabled.
4. cell = matrix[type][hop]; read Reply/Tapback/ReplyDm.
5. Tapback → always on-channel/as-DM as received (never forced DM).
6. Reply → routed via DM to sender when cell.ReplyDm (or type===Direct).

## Touch list
- `src/server/constants/settings.ts` — +12 keys (VALID + per-source); keep
  deprecated keys valid for the migration read.
- `src/server/meshtasticManager.ts` `checkAutoAcknowledge` — rewrite stages 11-15.
- `src/server/migrations/NNN_autoack_matrix.ts` + registry + migrations.test.ts.
- `src/contexts/AutomationContext.tsx` — state/setters/load/save for 12 keys.
- `src/components/AutoAcknowledgeSection.tsx` — 2×2 matrix UI.
- Tests: `meshtasticManager.autoack-*.test.ts`, `AutoAcknowledgeSection.test.tsx`.
- MeshCore (`meshcoreManager.ts`) is a separate, simpler path — OUT of scope.
