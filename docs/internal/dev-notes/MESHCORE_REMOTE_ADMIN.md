# MeshCore Remote Administration — Architecture Notes

Internal reference for anyone touching the MeshCore CLI/admin code. Covers
the wire protocol, the credential store, the danger guard, the local-vs-
remote dispatch, and the shared frontend primitive.

> **Read this first if you're about to:** add a new admin route, change the
> credential storage, expose a new MeshCore CLI surface, or rename anything
> in `meshcoreManager.ts` / `meshcoreNativeBackend.ts` / `CliConsoleBody.tsx`.

## TL;DR

- **MeshCore admin is CLI text sent as an encrypted DM with `txt_type = 1`.**
  No dedicated PortNum, no Meshtastic-style AdminMessage protobuf.
- **Server-side ACL on the remote node** authorizes the sender by their
  X25519 public key. `setperm <pubkey> <level>` mutates that ACL.
- **Saved passwords are AES-256-GCM-encrypted** with an HKDF-derived key
  from `SESSION_SECRET`. Each envelope carries a `kid` fingerprint so a
  rotated `SESSION_SECRET` is detected and surfaced cleanly (not as a
  silent auth-tag failure).
- **The plaintext password never crosses the wire to the frontend** after
  it's first saved. The auto-login route reads the envelope, decrypts
  server-side, and uses the plaintext in-process only.
- **Destructive commands require `confirm: true`** in both the client
  modal and the server route. Same regex in both places.
- **Local and remote consoles share `CliConsoleBody`.** The difference
  is what wraps it: remote layers login + capability + auto-login + stats
  on top; local does not.

## The MeshCore protocol surface

### Why there's no separate "admin" packet type

MeshCore's design choice: a CLI command going to a remote repeater is
just an encrypted DM with one byte flipped. The packet type is the same
`PAYLOAD_TYPE_TXT_MSG = 0x02` as a normal chat message. The distinguishing
field is **`txt_type`**:

```
txt_type byte (first byte of the encrypted body):
  0  TxtTypes.Plain        — chat DM
  1  TxtTypes.CliData      — CLI command (or reply)
  2  TxtTypes.SignedPlain  — chat DM with 4-byte sig prefix (rare)
```

This means the entire wire-level "admin protocol" is reusing the DM
plumbing. Encryption is the per-contact X25519 ECDH shared secret. The
remote node's firmware dispatches the text into `CommonCLI::handleCommand`
when `txt_type == 1` instead of the chat handler.

**Consequence for MeshMonitor:** routing CLI traffic out of the chat log
matters. `meshcoreNativeBackend.ts` filters incoming `ContactMsgRecv`
events by `msg.txtType` — `CliData` emits a `cli_reply` bridge event
instead of `contact_message`. Without that filter, CLI output would land
in the user's chat thread.

### Single-packet, no chunking, no request IDs

Replies are **always one packet** (≈130-180 bytes after framing). There
is no fragmentation. Long output (`get acl` listing 50 entries) is
truncated at the firmware level — there is no application-level way to
ask "send me the rest."

There is also **no request ID** in the protocol. Correlation is by sender
pubkey + the implicit ordering: we serialize one outstanding command per
remote node (per-prefix lock in `meshcoreManager.ts`) so the next reply
must belong to the in-flight command. Two callers can't have overlapping
requests against the same target.

This also means **never expose a "send N commands in parallel" API**.
That breaks the correlation invariant and will silently misroute replies.

### Authentication model

There is no separate admin keypair. The authenticating identity is the
sender's normal node X25519 public key. Authorization is a server-side
ACL on the remote node keyed on that pubkey.

`CMD_SEND_LOGIN` (companion-protocol opcode 26) populates that ACL. After
a successful login, the remote stores `{pubkey → permission_level}` and
subsequent CLI commands from that pubkey are dispatched at the granted
level. The ACL slot can be evicted (LRU when full) or wiped on reboot,
which is why `loginToNode` is treated as cheap to repeat.

The login replay-protection check is a timestamp in the request, so
clocks must be roughly aligned. The companion firmware doesn't sync
clocks automatically — that's what `clock sync` is for.

Permission levels (from `setperm <pubkey-hex> <level>`):

| Level | Name        | What it lets you do                                |
|-------|-------------|----------------------------------------------------|
| 0     | (remove)    | Revoke the ACL entry entirely                      |
| 1     | Guest       | Read-only stats / telemetry / `ver`               |
| 2     | ReadWrite   | Room servers only — post to the room              |
| 3     | Admin       | Full config + ACL management                      |

The `MeshCoreAclManager` form maps directly to this command. No level=2
on Repeaters in practice — the dropdown still exposes it because the
firmware accepts it.

## Credential store

Lives in `src/server/services/meshcoreCredentialStore.ts`.

### Why AES-GCM + HKDF instead of bcrypt?

The remote-admin password must be **reversible** — we need the plaintext
to feed to `loginToNode`. One-way hashes (bcrypt/argon2) would defeat
the purpose. AES-256-GCM gives confidentiality + integrity.

### The key fingerprint (`kid`)

Each envelope is:

```json
{
  "v":   1,
  "kid": "9940d2e5",
  "iv":  "<24 hex chars>",
  "ct":  "<hex>",
  "tag": "<32 hex chars>"
}
```

- `v` — KDF version. Bump on info-string changes.
- `kid` — first 4 bytes of `HKDF(SESSION_SECRET, "meshcore-admin-creds-fingerprint-v1")`. **NOT the encryption key.** Lets us detect "this row was encrypted with a different `SESSION_SECRET`" cheaply, without attempting decrypt.
- `iv` — 12-byte AES-GCM nonce, random per envelope.
- `ct` — ciphertext.
- `tag` — 16-byte AES-GCM auth tag.

The actual encryption key is `HKDF(SESSION_SECRET, "meshcore-admin-creds-aead-v1", 32)` — different info-string so the fingerprint can't be used to attack the key.

The HKDF uses a stable zero salt because we need deterministic derivation
— we can't persist a random salt without re-introducing the same
"rotation detection" problem we're trying to avoid.

### Three load outcomes

`store.load(sourceId, publicKey)` returns one of:

- `{ kind: 'none' }` — nothing saved.
- `{ kind: 'ok', password }` — decryption succeeded; the password is the
  plaintext, **for in-process use only**. Never echo it in any response.
- `{ kind: 'key_rotated', storedKid }` — saved envelope doesn't decrypt
  under the current `SESSION_SECRET`. UI surfaces this as a banner and
  prompts re-entry. We do NOT return `storedKid` to the frontend — an
  attacker shouldn't be able to enumerate prior fingerprints.

### Capability gating

When `SESSION_SECRET` is auto-generated (not configured via env), the
store reports `canRemember=false`. The route refuses to persist with
`code: CREDENTIAL_PERSISTENCE_DISABLED` and the UI hides the "Remember
password" checkbox with a tooltip explaining why. Persisting against an
ephemeral key would lose every saved password on every restart, which
is worse than just re-prompting.

### Threat model boundary

The credential store defends against **DB-file-only exfil**. Someone
who grabs `meshmonitor.db` without the host environment can't decrypt.

It does **not** defend against host compromise. Anyone running code on
the server has both `SESSION_SECRET` and the DB. This is the same
posture as the existing channel-PSK storage (which is plaintext in the
DB by design, because the server uses those PSKs to decrypt packets).

## The danger guard

Pattern: `/\b(reboot|erase|clkreboot|factory)\b(?!\.)/i`.

The `(?!\.)` after the word boundary exists because these firmwares expose
config keys as dotted paths that legitimately contain the danger words as
a namespace prefix — e.g. `get reboot.interval` or `set clkreboot.retries
3` — which are read/write config operations, not the destructive verb
itself. Without the exclusion, any command referencing such a key (even a
plain `get`) trips the confirmation prompt. See #4025.

**Two independent enforcement points**, intentionally duplicated:

1. **Server-side** in `meshcoreRoutes.ts` for both `/admin/cli` and
   `/cli`. The regex constant `DANGER_COMMAND_PATTERN` is defined once
   in the file; the routes share it.
2. **Client-side** in `CliConsoleBody.tsx`. Same regex literal. Opens a
   typed-name confirmation modal where the user must type the contact
   name (or local device name) to enable Confirm.

The client modal is the natural UX; the server check is defense in
depth so a script or hostile browser extension that strips the modal
still gets the prompt-as-requirement.

**If you change the regex on one side, change it on the other.** The
test `it.each([['reboot'],['Reboot'],['erase'],['clkreboot'],['factory reset'],['set factory mode']])`
in `meshcoreRoutes.test.ts` catches a missed update on the server side.
`CliConsoleBody.test.tsx` mirrors the same cases (plus the dotted-path
negatives from #4025) directly against the exported
`DANGER_COMMAND_PATTERN` constant, so a drift between the two copies now
fails on the client side too.

## Local vs remote dispatch

Both go through `CliConsoleBody`, but the wire path is completely
different.

### Remote (`/admin/cli`)

- Target: arbitrary node on the mesh, by `publicKey`.
- Path: `MeshCoreManager.sendCliCommand` → `send_cli` bridge command
  → `connection.sendTextMessage(pubkey, text, TxtTypes.CliData)`.
- Reply arrives async via `ContactMsgRecv` event with `txtType=CliData`.
- Auth: server-side ACL on the remote, populated by a prior `loginToNode`.
- Permission: `remote_admin:write` per-source.

### Local (`/cli`)

- Target: the locally-connected device. No `publicKey` parameter.
- Permission: `configuration:write` per-source.
- Dispatch depends on local firmware (`deviceType`):

| Local firmware | What you get |
|---|---|
| Repeater / Room Server (2/3) | Forwarded to `sendRepeaterCommand`. The device has a real serial text CLI. Whatever the device prints comes back. |
| Companion (1) | `runSyntheticLocalCli` — a small interpreter mapping `ver` / `stats [core\|radio\|packets]` / `clock` / `advert` / `help` to existing companion-protocol bridge commands. Unknown verbs return a usage hint, NOT an error. |
| Unknown (0) | 400 — "not available for this device type". The catalog also hides the quick-action row so the user can't blindly click commands that won't work. |

**The Companion synthetic CLI is intentionally small.** It covers
read-only state inspection. Mutating verbs (`set name`, `set radio`,
etc.) are deliberately omitted because the existing form UI in
`MeshCoreConfigurationView` already handles them with proper validation.
Adding `set X` to the synthetic CLI would duplicate that logic without
adding capability.

If you need to extend the synthetic CLI: add the verb to
`runSyntheticLocalCli`, add the catalog entry to
`COMPANION_ACTION_CATALOG` in `MeshCoreLocalConsole.tsx`, and add a
unit test to `meshcoreManager.localCli.test.ts`.

## The CliConsoleBody primitive

`src/components/MeshCore/CliConsoleBody.tsx` owns:

- The transcript (`sent` / `reply` / `error` / `info` line kinds).
- The command input + Send button.
- The quick-action button row driven by `actionCatalog` prop.
- The danger-confirm modal.
- The ↑/↓ command history (in-memory, component-scoped, cap of 50).

Wrappers layer additional state on top via the imperative handle
(`CliConsoleBodyHandle`):

```typescript
interface CliConsoleBodyHandle {
  appendInfo(text: string): void;         // push an info line
  clear(): void;                          // wipe transcript
  runCommand(cmd, opts?): Promise<void>;  // run as if user typed it
}
```

`runCommand` is the entry point for sibling forms (e.g.
`MeshCoreAclManager`) that want their result to land in the same
transcript as free-typed commands. The form calls
`bodyRef.current.runCommand('setperm abcd... 3')` and the lifecycle
(transcript append → wire send → transcript reply) runs exactly as if
the user had typed and pressed Send.

### Why three transcript line kinds for output?

- `sent` (`>` prefix, blue) — request side.
- `reply` (`<` prefix, default color) — happy-path response.
- `error` (`!` prefix, red) — fetch failed, timeout, rejection.
- `info` (`*` prefix, italic muted) — system-level messages: "Logged
  in", "Logged in with saved password", "Stored password forgotten".

Keep these distinct so a user scanning the transcript can tell at a
glance whether something needs attention.

## File map

| Path | Role |
|---|---|
| `src/server/services/meshcoreCredentialStore.ts` | AES-GCM + HKDF, capability + key-rotation detection. |
| `src/server/meshcoreManager.ts` | `sendCliCommand` (remote, serialized), `sendLocalCliCommand` (dispatcher), `runSyntheticLocalCli` (Companion). |
| `src/server/meshcoreNativeBackend.ts` | `send_cli` bridge command + `cli_reply` event filter. |
| `src/server/routes/meshcoreRoutes.ts` | `/admin/cli`, `/admin/login`, `/admin/login-with-saved`, `/admin/credentials-capability`, `/admin/credentials/:pk` DELETE, `/cli`. `DANGER_COMMAND_PATTERN` lives here. |
| `src/server/migrations/070_meshcore_admin_credential.ts` | `meshcore_nodes.adminCredential` column. |
| `src/components/MeshCore/CliConsoleBody.tsx` | Shared transcript / input / actions / danger modal / history. |
| `src/components/MeshCore/MeshCoreRemoteConsole.tsx` | Remote wrapper: login + capability + auto-login + rotated banner + stats. |
| `src/components/MeshCore/MeshCoreLocalConsole.tsx` | Local wrapper: device-type-aware catalog, no auth layer. |
| `src/components/MeshCore/MeshCoreAclManager.tsx` | Setperm form, mounted alongside the body for Repeater / RoomServer targets. |
| `src/components/MeshCore/MeshCoreRemoteStatsPanel.tsx` | Structured status panel for the remote console. |

## PR history

| PR | What landed |
|---|---|
| #3160 | Phase 1-3: backend primitives, credential store, remote console with login + auto-login. |
| #3161 | Phase 4a: stats panel, quick-action buttons, danger-command guard. Catppuccin theming pass. |
| #3162 | Local CLI console in the Configuration view; `CliConsoleBody` extracted as a shared primitive. |
| (this) | ACL manager form, command history, this doc. |

## Things that look tempting but aren't worth doing

- **Adding `set <key> <value>` to the synthetic Companion CLI.** Already covered by the configuration form with proper validation.
- **Adding `get acl` UI to the remote console.** The `get acl` command is serial-only on the firmware side — it won't reply over the mesh. Use the binary `REQ_TYPE_GET_ACCESS_LIST` request if you really need a list view (not wrapped in meshcore.js yet; would need a new bridge command).
- **Removing the per-prefix CLI serialization to "speed up" admin work.** The protocol has no request IDs — serialization is the only way reply routing stays correct. Don't.
- **Letting the client send a `kid` to identify which envelope to decrypt.** Pointless: there's only one envelope per (sourceId, publicKey) pair, and exposing kid to the client gives a hostile script a way to fingerprint `SESSION_SECRET` rotations.

## Things that ARE worth doing later

- **`reboot` for local Companion** — add `case 'reboot'` to the dispatch in `meshcoreNativeBackend.ts` mapping to `connection.reboot()`. Wire it up in the synthetic CLI catalog. ~15 lines total.
- **Structured `GetAccessList`** — wrap the binary request in `meshcoreNativeBackend.ts` and add a list view to `MeshCoreAclManager`. Would let users see what's currently in the ACL before changing it.
- **Persist transcript / history across remounts** — sessionStorage keyed on `targetId`. Useful if users frequently switch contacts mid-session.
- **Per-command audit log entries** — `requirePermission` already audits the route call, but the command text isn't in the audit row. One-line addition in each CLI handler.
- **Command autocomplete on Tab** — would benefit both consoles; lives in `CliConsoleBody`.
