---
name: reference_pki_dm_crypto_scheme
description: Byte-exact PKI DM crypto scheme - X25519 ECDH + SHA-256 + AES-256-CCM, nonce layout, 12-byte overhead, wire format, firmware functions
metadata:
  type: reference
---

# Meshtastic PKI Direct-Message Crypto (byte-exact)

Source: firmware `src/mesh/CryptoEngine.cpp` (master), `src/mesh/Router.cpp`, `src/mesh/RadioInterface.h`, protobuf `meshtastic/mesh.proto`.

## Scheme
- **Curve**: Curve25519 / X25519. 32-byte private + 32-byte public key (raw little-endian field bytes, NOT clamped-display). Generated via `Curve25519::dh1`. `setDHPublicKey` does `Curve25519::dh2(shared, priv)` = raw ECDH.
- **Shared secret -> AES key**: `shared = X25519(our_private, their_public)` (32 bytes), THEN `hash(shared,32)` = **SHA-256(shared)** in place. The SHA-256 output (32 bytes) is the AES-256 key. NOT raw ECDH used directly.
- **Cipher**: **AES-256-CCM**, MAC/auth-tag length = **8 bytes** (`aes_ccm_ae(key,32,nonce,8,...)` — the `8` is the tag length, not nonce length). No AAD (AAD ptr null, len 0).
- **Nonce**: 13-byte CCM nonce built by `initNonce(fromNode, packetId, extraNonce)` into a 16-byte buffer; CCM uses first 13:
  - bytes 0-7: packetId as uint64 LE
  - bytes 8-11: fromNode as uint32 LE
  - bytes 12-15: extraNonce uint32 LE (only written if extraNonce != 0)
  - SAME layout as channel AES-CTR nonce; difference is PKI fills extraNonce with a random per-packet 32-bit value instead of block-counter.
- **packetNum/packetId** passed to nonce is the MeshPacket `id` (fixed32 on wire) widened to uint64; high 32 bits are 0.

## Wire format (MeshPacket.encrypted bytes)
`[ciphertext (numBytes)] [8-byte CCM MAC] [4-byte extraNonce LE]`
- Total overhead = **MESHTASTIC_PKC_OVERHEAD = 12** (`src/mesh/RadioInterface.h`: 8 MAC + 4 extraNonce).
- In decrypt: `auth = bytes + numBytes - 12`; MAC = auth[0..7]; extraNonce = LE u32 at auth[8..11]. Ciphertext length fed to CCM = `numBytes - 12`.
- extraNonce is NOT in a protobuf field — it is the last 4 bytes of the `encrypted` blob.

## Protobuf fields
- `MeshPacket.encrypted` (field 8, bytes): the ciphertext+MAC+extraNonce blob.
- `MeshPacket.public_key` (field 16, bytes): only set by firmware AFTER successful decrypt as a record of the SENDER's pubkey; receiver does NOT read it as input (it pulls sender pubkey from NodeDB). Not a transport field for decryption input.
- `MeshPacket.pki_encrypted` (field 17, bool): flag set true after PKI en/decrypt.

## Firmware functions
- `CryptoEngine::decryptCurve25519(fromNode, remotePublic, packetNum, numBytes, bytes, bytesOut)` — CryptoEngine.cpp ~L128.
- `CryptoEngine::encryptCurve25519(...)` ~L88.
- `setDHPublicKey` (ECDH) L195; `hash` (SHA-256) L165; `initNonce` L263.
- Router invocation: `Router::perhapsDecode` Router.cpp ~L446-466.

## Send/receive selection (Router.cpp)
- Receiver tries PKI ONLY when: `p->channel==0 && isToUs(p) && p->to>0 && !isBroadcast(p->to)` && both from/to nodes have 32-byte pubkeys in NodeDB && `rawSize > 12`. PKI is unicast-DM only; broadcast falls back to channel AES-CTR.
- Sender uses PKI when destination node has 32-byte pubkey, `config.security.private_key.size==32`, not broadcast, and not Ham/licensed mode.

## Node.js reimpl notes
- @noble/curves `x25519.getSharedSecret(ourPriv32, theirPub32)` returns raw ECDH; then `crypto.createHash('sha256').update(shared).digest()` = AES key.
- AES-256-CCM via Node `crypto.createDecipheriv('aes-256-ccm', key, nonce13, {authTagLength:8})`, setAAD not needed (no AAD), setAuthTag(mac8), update(ciphertext), final().
- Build 13-byte nonce; do NOT pad to 16 for the CCM call.
