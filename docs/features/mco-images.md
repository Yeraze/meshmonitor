# MCOimg Images

MeshMonitor draws MCOimg v3 (`im3:`) messages as images. They show in Meshtastic and MeshCore channels, direct messages, rooms, and Unified Messages.

MCOimg packs a small image into one text message, so it costs no more airtime than any other message. You make one with the online encoder at <https://hdden.ru/MCOimg/>, then paste the code into the message box. Sending from MeshMonitor comes in a later release.

---

## When a message is drawn as an image

So that ordinary chat stays as text, a message is drawn as an image only when:

- the whole trimmed message is one `im3:` payload, with nothing before or after it;
- `im3:` is lowercase;
- it has at most 512 characters;
- the image is at most 256 by 256 pixels;
- the data is valid for the IM3 format.

Anything else shows as plain text. That covers `IM3:`, text mixed with a code, bad or cut-off data, and IM4 messages (`im4:`), which stay text for now.

MeshMonitor shows each image at up to 192 pixels on its longest side, so a small image does not fill the screen. While the decoder loads, and if a message fails to decode, you see the original text.

---

## Using an image message

- Hover over an image, or tab to it, to see its exact payload.
- Select **Copy original message** under an image to copy the payload. Use this on touch screens, where there is no hover.
- Image messages have no Translate button, and link previews skip them.

---

## Bridged messages

A bridge can add a sender tag to the message body, such as `MC@Alice: im3:...`. The message is then no longer only a payload, so it shows as text. The MeshMonitor MeshCore and Meshtastic bridge does this.

---

## Public instances

A public instance hides message text from anonymous viewers before MeshMonitor decodes anything, so hidden messages never turn into images.

---

## Credits

The MCOimg format and its reference codec come from HDDen's `meshcore-open` fork:

- [MCOimg v3 reference](https://github.com/HDDen/meshcore-open/blob/rename-mco-advanced/docs/mcoimg_v3_reference.md)
- [JavaScript codec](https://github.com/HDDen/meshcore-open/blob/rename-mco-advanced/docs/mcoimg-js/mcoimg-v3-codec.global.js)

The code is MIT licensed, copyright (c) 2025 zjs81. MeshMonitor ports the decoder to TypeScript. See `THIRD_PARTY_DATA.md` for details.

<!-- TODO: add the screenshot ![...](/images/features/mco-images.png) once it exists. -->
