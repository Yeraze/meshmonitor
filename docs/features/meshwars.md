# MeshWars

[MeshWars](https://github.com/zvx-echo6/meshwars) is a territory game played over mesh radio. Seven teams claim map squares about 300 m across by reaching the mesh from them. On MeshCore, a square is scored from a ping: where the radio was, and which repeaters heard it.

MeshMonitor can send those pings for a MeshCore radio it's connected to, so the radio plays without the MeshMapper app.

---

## How it works

When a repeater re-floods a channel message you send, MeshMonitor already notices and lists the repeaters under the message. With MeshWars on, it waits 30 seconds for more repeaters to show up, then sends MeshWars one ping:

- the radio's position, from its own advert settings;
- the repeaters that heard the message, with their SNR;
- the first 8 characters of the radio's public key, which MeshWars uses to match the radio to your player.

This is the same ping the MeshMapper app sends, posted to MeshWars' `/api/mc/ingest`.

**Nothing extra goes over the mesh.** MeshMonitor only reports on messages you already sent. A message that no repeater heard sends nothing, because MeshWars wouldn't score it.

---

## Limits

- **At most one ping every 5 minutes.** MeshWars won't let the same player repaint the same square within 5 minutes, so more would score nothing. The time of the last ping is saved, so restarting MeshMonitor or saving settings doesn't reset the wait.
- **A failed ping isn't retried.** The error shows in the settings section.
- **Only a radio with a position is sent.** If the radio's advert has no latitude and longitude, nothing is sent.

---

## Setting it up

1. Register at MeshWars' `/join` page and copy the API key it shows. It's only shown once.
2. In MeshMonitor, open **Settings → MeshWars**. Only an admin can see this section, because it sends a radio's position to another server.
3. Tick the box, choose the **MeshCore source**, and paste the **API key**.
4. Leave the **URL** as `https://meshwars.com` unless you play on a self-hosted server.
5. Save, then send a message on any channel your repeaters carry.

After a message is heard, the section shows when the last ping was sent and whether MeshWars accepted it.

::: tip
A radio at a fixed spot only ever claims its own square. To claim more ground, take the radio with you, the same as with MeshMapper.
:::

---

## Privacy

The API key is stored on the server and never sent back to the browser. MeshWars says it reduces each position to its grid square before saving it. See the [MeshWars privacy notes](https://github.com/zvx-echo6/meshwars#privacy).
