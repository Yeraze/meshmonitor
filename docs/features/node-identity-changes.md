# Node Number Changes (Meshtastic 2.8)

Meshtastic 2.8 changed how a node picks its node number. Before 2.8 the number
came from the radio's hardware MAC address. From 2.8 it is derived from the
node's public key instead.

The practical effect is blunt: **every node that upgrades to 2.8 gets a new node
number**, and MeshMonitor sees it as a brand-new node.

If your whole mesh upgrades over a weekend, most of your node list goes dark and
a set of look-alike entries appears beside it. Nothing is broken. This page
explains what you are seeing, what MeshMonitor does about it, and what it
deliberately does not do.

## What actually happens

On its first 2.8 boot a node computes `crc32(public_key)` and adopts that as its
node number. The keypair itself is untouched — the node keeps the same key it
had on 2.7 — so only the number moves.

The change is one-way. Downgrading the firmware does not restore the old
number, and the firmware sends nothing that links the old number to the new one.
Every other node on the mesh, and every tool watching it, simply sees the old
node stop transmitting and a new one start.

A node with no public key keeps its MAC-derived number. Keys are generated only
once a region is set, so an un-provisioned node can renumber days or weeks after
it first ran 2.8 — for example the first time someone sets its region.

## What you will see in MeshMonitor

- The old entry stops updating. Its last-heard time freezes at the moment of the
  upgrade and it ages out of your "active nodes" view like any silent node.
- A new entry appears with the same long name and short name, a new node ID, and
  no history.
- Telemetry graphs, position history, packet logs, traceroutes and messages
  recorded before the upgrade stay attached to the **old** node number. They are
  not lost, but they are no longer reachable from the new entry.
- On the map you may briefly see both, until the old one falls outside your
  node-age window.

## The identity-change notice

MeshMonitor detects the likely pairing and tells you about it. Look for the
identity badge in the node list — it appears on **both** halves of a pair, with
the wording flipped:

- On the **new** node: *"this is likely the node previously known as …"*
- On the **old**, silent node: *"this node has likely continued as …"*

![Two entries for the same node in the list, each carrying the identity badge](/images/features/node-identity-change-list.png)

Open **Node Details** for either one and you get the long form: which node it is
paired with, what the pairing is based on, and where the old history lives.

![The Node Details identity-change notice](/images/features/node-identity-change-notice.png)

### How the pairing is worked out

Three signals, strongest first:

| Basis | Confidence | What it means |
|-------|-----------|---------------|
| `derivedNodeNum` | High | The old entry's public key CRC-32s to exactly the new entry's node number. That is the firmware's own rule, so this is a verification rather than a guess — and it holds even if you renamed the node during the upgrade. |
| `publicKey` | High | Both entries carry the same public key. A node keeps its key across the upgrade, so this is the same node. |
| `name` | Medium | Long name and short name match, and neither entry has a key on file. This is a genuine guess — two different nodes can share a name. |

A pairing is only reported when the timing also looks like a handover: the old
entry fell silent around the time the new one first appeared, it is still silent
now, and the new entry is the one currently transmitting.

Two guards keep false pairings out:

- **Different keys are a hard veto.** If both entries carry a public key and the
  keys differ, they cannot be the same node under 2.8's rule, however well the
  names line up. Two same-named neighbours are never paired.
- **Firmware-default names are ignored.** An entry still called
  `Node !a1b2c3d4` has never sent its NodeInfo. Matching on that placeholder
  would pair every unnamed node with every other one.

The notice retires once the new entry is no longer new (90 days), so an old name
collision never becomes a permanent badge.

### Detection is per-source

A node on one source is never compared against a node on another. Two sources
are two different meshes — a shared name or key across them says nothing about a
firmware upgrade, and pairing across them would leak node names past the
per-source permission boundary.

If you watch the same physical mesh through both a direct TCP source and an MQTT
source, you will see the notice separately on each, which is correct: each
source keeps its own node table.

## What MeshMonitor will not do

**It will not merge anything automatically.** No history is moved, re-keyed or
deleted, and there is no button to do it either.

This is deliberate. The `name` basis is a heuristic, and an automatic merge on a
name collision would splice two unrelated nodes' telemetry, positions and
message history together — irreversibly, and without anyone noticing until the
graphs looked wrong. The cost of a missed merge is an operator reading two
charts instead of one. The cost of a wrong merge is corrupted data.

So MeshMonitor states what it observed and leaves the decision to you.

## What to do about it

For most operators: nothing. Let the old entry age out. New telemetry
accumulates under the new number and the graphs fill in again over the following
days.

If you want a tidy list sooner:

- **Re-favourite the node** under its new number, if you had favourited it.
- **Update any automations, notification rules or monitored-node lists** that
  reference the node explicitly. These are keyed on node number and will keep
  pointing at the silent old entry until you change them.
- **Delete the old entry** once you no longer need its history (node list →
  delete). This is destructive — the old telemetry and position history go with
  it — so do it only when you are sure the pairing is right, and prefer waiting
  if the notice says the basis was `name`.

## Related: duplicate-key security warnings

MeshMonitor separately warns when two nodes share a public key, because that is
also what an impersonation attempt looks like. A 2.8 renumber briefly produces
exactly that shape: one key, two node numbers.

The two are told apart by liveness. In an upgrade the old identity never
transmits again; in an attack both parties are transmitting at once.
MeshMonitor suppresses the security warning only for the clear handover case —
see [Duplicate Encryption Keys](/security-duplicate-keys).

If you see a duplicate-key warning that has **not** been suppressed, and both
node numbers are actively transmitting, treat it as a security issue rather than
a firmware upgrade.

## One more 2.8 change worth knowing

From 2.8, a node's NodeInfo reports an all-zero MAC address for every node except
the local one — the field was dropped from the firmware's internal node record
and is zero-filled for backward compatibility. A blank or `00:00:00:00:00:00`
MAC on a 2.8 node is expected, not a fault.

## Source

Meshtastic 2.8.0 release notes: *"Node numbers (ID) are now derived from the
public-key identity of the node instead of hardware mac address."*
