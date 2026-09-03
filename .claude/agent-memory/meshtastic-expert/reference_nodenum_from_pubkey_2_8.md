---
name: nodenum-from-pubkey-2-8
description: Firmware 2.8 derives node_num = CRC32(public_key) (zlib CRC-32 over the 32 raw bytes); upgrading nodes KEEP their 2.7 keypair, so "same public_key, new node_num" is a reliable upgrade signal
metadata:
  type: reference
---

Meshtastic 2.8 changed NodeNum from MAC-derived to public-key-derived.

## The formula
`my_node_num = crc32Buffer(config.security.public_key.bytes, 32)`

- `crc32Buffer` is from **ErriezCRC32 1.0.1** (`platformio.ini`), pinned via
  `https://github.com/Erriez/ErriezCRC32/archive/refs/tags/1.0.1.zip`.
- It is standard **CRC-32/ISO-HDLC** (init `0xFFFFFFFF`, reflected poly
  `0xEDB88320`, final `~`) — identical to `zlib.crc32`.
- JS equivalent: `zlib.crc32(pubkeyBuf) >>> 0` (or any CRC-32 over the raw 32
  bytes, **not** the base64 string).

## Key firmware sites (tag `v2.8.0.47db0e3`)
- `src/mesh/NodeDB.cpp:531` — non-keygen branch sets `my_node_num` directly.
- `src/mesh/NodeDB.cpp:4504` `NodeDB::createNewIdentity()` — the real mover.
  Early-returns when the CRC is unchanged; otherwise `removeNodeByNum(oldNodeNum)`
  (drops the old self-entry entirely) then `my_node_num = newNodeNum`.
- `src/mesh/NodeDB.cpp:4538` `NodeDB::ensurePkiIdentity()` — out-of-boot mint.
- `src/mesh/NodeDB.cpp:2103` `pickNewNodeNum()` — still MAC-derived; it is only
  the *provisional* number used before keys exist.
- `src/mesh/Router.cpp:~710` `verifyFirstContactNodeInfo()` — enforces
  `crc32(user.public_key) == p->from` on first-contact NodeInfo. The binding is
  validated on the wire.
- `src/modules/AdminModule.cpp:78` `licensedIdentityWillMigrate()` — same CRC check.

## Upgrade behavior (the load-bearing bit)
`NodeDB::generateCryptoKeyPair()` calls `crypto->regeneratePublicKey()`, which is
`Curve25519::eval(pub, priv, 0)` — **byte-identical in 2.7 and 2.8**. A node that
already had a 32-byte private key keeps the exact same public key across the
2.7 -> 2.8 upgrade; only the node number moves.

=> **Same public_key + different node_num == that node upgraded to 2.8.**
Far stronger than name matching. Exception: keys on the
`LOW_ENTROPY_HASHES` list are force-regenerated (pubkey AND num both change),
and `set_ham` / licensed mode mints a fresh identity.

## Nodes with no key
No key => no CRC => number stays MAC-derived. Happens when:
- `config.lora.region == UNSET` (keygen is gated on region being set),
- `MESHTASTIC_EXCLUDE_PKI_KEYGEN` / `MESHTASTIC_EXCLUDE_PKI` builds,
- degraded boot (`configDecodeFailed`).
Setting the region later triggers `ensurePkiIdentity()` and the number moves
*then* — so a renumber can happen well after first boot.

## No migration announcement
Nothing on the wire links old -> new. `createNewIdentity()` only purges the old
entry from its *own* DB. Peers keep the stale MAC-derived ghost until it ages
out — `NodeDB::updateUser()` has no "same pubkey under a different nodenum"
dedupe. That cleanup is ours to do.

## No collision avoidance on the derived number
`createNewIdentity()` assigns the CRC verbatim: no `NUM_RESERVED` guard, no
`NODENUM_BROADCAST` guard, no in-DB dedupe loop. Only the legacy MAC path in
`pickNewNodeNum()` has the retry loop.

## Related
`src/mesh/TypeConversions.cpp:150` — `User.macaddr` is now **zero-filled** for
every non-self node. Do not read peer MACs from NodeInfo on 2.8.

See also [[fw28-phoneapi-nodedb-replay]].
