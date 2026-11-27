# MCOimg Images

MeshMonitor draws MCOimg v3 (`im3:`) and v4 (`im4:`) messages as images. A v3 image is a grid of pixels. A v4 image is a drawing with shapes and text, so it stays sharp at any zoom. They show in Meshtastic and MeshCore channels, direct messages, rooms, and Unified Messages.

MCOimg packs a small image into one text message, so it costs no more airtime than any other message. You can make one in MeshMonitor (see [Sending an image](#sending-an-image)) or with the online encoder at <https://hdden.ru/MCOimg/> and paste the code into the message box.

![An MCOimg v3 image in a channel, with the payload shown on hover and a Copy original message button](/images/features/mco-images.png)

![An MCOimg v4 weather card from the issue sample, with its captions drawn as text](/images/features/mco-images-im4.png)

---

## When a message is drawn as an image

So that ordinary chat stays as text, a message is drawn as an image only when:

- the whole trimmed message is one `im3:` or `im4:` payload, with nothing before or after it;
- the prefix is lowercase;
- it has at most 512 characters;
- the image is at most 256 by 256 pixels;
- the data is valid for its format;
- for IM4, the drawing stays inside the caps below.

Anything else shows as plain text. That covers `IM3:` and `IM4:`, text mixed with a code, and bad or cut-off data. It also covers IM4 images that use a feature MeshMonitor does not support yet, or that are too complex to draw safely.

IM4 caps:

- 4096 figures
- nesting depth of 16
- 16384 path points
- 16 raster layers and 262144 raster pixels in all
- 4096 text code points

An IM4 image over any cap shows as the original text.

MeshMonitor shows each image at up to 192 pixels on its longest side, so a small image does not fill the screen. An IM4 image with a caption shows at up to 256 pixels. While the decoder loads, and if a message fails to decode, you see the original text.

---

## Text in IM4 images

An IM4 image sends its text as characters, not pixels. MeshMonitor draws the text with the page font, so it can look a little different from the MeshCore Open app, and line breaks can differ. Screen readers read the text out.

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

## Sending an image

Every message box has a **+** button. Choose **Insert image** to open the image dialog.

![The Insert image dialog showing IM3 and IM4 previews of a photo, each with its byte count and a Fits mark](/images/features/mco-images-compose.png)

1. Pick a PNG or JPEG file, up to 25 MB.
2. Choose **Auto** or **Manual**.
   - **Auto** finds the largest picture that fits the message limit. It ranks each choice by width x height x log2(colours), so a bigger picture or more colours both score higher.
   - **Manual** lets you set the size and palette yourself. It also has a **Dither** switch.
3. Check the two previews. Each one is decoded from the exact text it would send, so you see what the other side sees.
   - **IM3** is a pixel grid.
   - **IM4** is the same pixels inside a v4 drawing. IM4 is usually a few bytes larger, so it may not fit when IM3 does.
4. Each preview shows its byte count and whether it fits. You cannot pick one that does not fit.
5. Select **Use**. The text goes into the message box. Send it like any other message.

Good to know:

- **Limits.** Meshtastic allows 200 bytes per message. MeshCore depends on the conversation: a direct message or room has a fixed limit, and a channel message gets less, because your node name counts too. The dialog uses the limit of the conversation you opened it from.
- **Nothing is uploaded.** MeshMonitor reads and shrinks the picture in your browser. It scales the picture down to 512 pixels, fills transparent areas with white, and maps each pixel to the nearest palette colour.
- **One message.** An image is one ordinary message. MeshMonitor never splits it, so it costs the same airtime as typed text of that length.
- **It replaces your draft.** An image must be the whole message, so **Use** replaces what you typed. The dialog says so. On MeshCore, this also drops the reply link. If you type after you insert, the message turns back into plain text.
- **Dithering.** Dither spreads the colour error across nearby pixels, which can look smoother. It adds 30 to 160 percent more bytes, so Auto never uses it and it is off by default.
- **Speed.** Auto first searches with the fast encoder. **Use** works as soon as a fitting result exists. In the background, a slower encoder tries to shrink the winner for up to 20 seconds, and MeshMonitor keeps whichever text is shorter. Phones are slower than desktops, so the extra step may find less there.

---

## Credits

The MCOimg formats and their reference codecs come from HDDen's `meshcore-open` fork:

- [MCOimg v3 reference](https://github.com/HDDen/meshcore-open/blob/rename-mco-advanced/docs/mcoimg_v3_reference.md)
- [JavaScript codec](https://github.com/HDDen/meshcore-open/blob/rename-mco-advanced/docs/mcoimg-js/mcoimg-v3-codec.global.js)
- [MCOimg v4 reference](https://github.com/HDDen/meshcore-open/blob/9.5.1-mod-1.9.0/docs/mcoimg_v4_reference.md) and [v4 codec](https://github.com/HDDen/meshcore-open/blob/9.5.1-mod-1.9.0/lib/helpers/mcoimg_v4_codec.dart) (tag `9.5.1-mod-1.9.0`)
- [MCOtxt v1 protocol](https://github.com/HDDen/meshcore-open/blob/9.5.1-mod-1.9.0/docs/MCOTXT_V1_PROTOCOL.md) and [`mcotxt.js` codec](https://github.com/HDDen/meshcore-open/blob/c38c1650fe8394835e333b5b4a1ac84ead2d5e5a/docs/mcotxt/assets/mcotxt.js)

The code is MIT licensed, copyright (c) 2025 zjs81. MeshMonitor ports the IM3 and IM4 decoders, the IM3 encoder, the IM4 raster encoder, and the MCOtxt decoder to TypeScript. See `THIRD_PARTY_DATA.md` for details.
