# PKI Direct Message Decryption

::: warning Security-sensitive — off by default
This feature stores a node's **private key** on the MeshMonitor server (encrypted at rest) so it can decrypt PKI direct messages. It is **disabled globally by default** and must be turned on deliberately. Only enable it on an instance you trust with that key material. See [Security model](#security-model) below.
:::

## What it does

Meshtastic encrypts direct messages (DMs) to a node using that node's public key (PKI). Normally only the destination device — which holds the matching private key — can read them. When you run MeshMonitor with **multiple radio sources**, a DM that arrives encrypted on one source (for example, relayed through an [MQTT bridge/broker](/features/mqtt-broker)) can't be shown, because MeshMonitor never held the key to decrypt it.

With PKI Direct Message Decryption enabled, MeshMonitor can decrypt those DMs **server-side** and surface them in the cross-source **[Unified Messages](/features/multi-source)** view — so a DM addressed to one of your nodes shows up even when it was received on a different source.

It decrypts **by destination**: when any source sees an encrypted DM addressed to node *X*, MeshMonitor looks up *X*'s stored private key (held by whichever source owns that node) and decrypts it with the sender's public key. The realistic source of such traffic is an MQTT bridge or broker source that relays PKI packets still-encrypted.

::: tip Why not "same source"?
A node already decodes DMs addressed to *itself* and hands them to MeshMonitor decoded, so decrypting those again would add nothing. The value here is **cross-source** aggregation.
:::

## Turning it on

There are two layers of control — a global master switch and a per-source toggle. **Both** must be on for a source to decrypt.

### 1. Global master switch

**Settings → Notifications & Security → "Enable PKI direct message decryption."**

This is the instance-wide kill switch. While it's **off** (the default):

- no source decrypts anything,
- the per-source toggles are inert, and
- turning it off **forgets every stored private key**.

### 2. Per-source toggle

Open a Meshtastic source, go to its **Configuration** tab, and enable **PKI Direct Message Decryption** for that source. This requires the per-source **`configuration`** [permission](/features/per-source-permissions).

When you enable it, MeshMonitor reads that source's local-node private key from the device's security config and stores it **encrypted**. From then on, PKI DMs addressed to that node are decrypted and appear in the unified view (subject to the normal per-source `messages:read` permission). Disabling the source's toggle **immediately forgets** its stored key.

## Requirements

- **`SESSION_SECRET` must be configured.** The stored private key is encrypted with a key derived from `SESSION_SECRET`. If it isn't set (an auto-generated value is in use), MeshMonitor refuses to persist keys and the per-source toggle is disabled with a warning. Set it with, e.g.:

  ```bash
  SESSION_SECRET=$(openssl rand -hex 32)
  ```

  ::: tip Desktop app
  The Windows/macOS desktop builds set a **stable, per-install `SESSION_SECRET`** automatically (persisted in the app's `config.json`), so the feature works there with no extra setup. If that config file is deleted, the secret rotates and stored keys are forgotten — the per-source toggle re-extracts the key on the next connect.
  :::

- Applies to **Meshtastic** sources only (TCP, MQTT bridge, MQTT broker). MeshCore sources are not affected.

## Security model

- **What it protects against:** someone who exfiltrates only the database file (without the host's `SESSION_SECRET`) can't read the stored keys (AES-256-GCM, key derived from `SESSION_SECRET`).
- **What it does *not* protect against:** a host compromise. Anyone who can run code on the server can read both `SESSION_SECRET` and the database, and therefore the private keys — which would let them impersonate those nodes on the mesh. This is the same trust boundary as MeshMonitor's stored MeshCore admin credentials.
- **Opt-in at every layer:** off globally by default, then per-source, then gated by the per-source `configuration` permission.
- **Key rotation:** if `SESSION_SECRET` changes, previously stored keys can no longer be decrypted and are treated as rotated (no decryption happens); the key is re-extracted and re-stored on the next connect while the source toggle is still on.

## Scope

Decrypted DMs are stored against the **receiving** source and flow into the normal message pipeline, so the unified feed's existing per-source `messages:read` permission still governs who can see them.

Re-delivering decrypted DMs back to a mobile client (e.g. through the [Virtual Node Server](/configuration/virtual-node)) is **not** part of this feature.
