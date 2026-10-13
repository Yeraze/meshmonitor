/**
 * meshcore-open reaction emoji table (wire index -> emoji).
 *
 * Vendored from https://github.com/zjs81/meshcore-open
 *   commit 3bee159c4fc954210578aa72236f58e14dedae6b
 *   file   lib/widgets/emoji_picker.dart (quickEmojis, smileys, gestures,
 *          hearts, objects, joined in that order by
 *          lib/helpers/reaction_helper.dart `reactionEmojis`)
 *
 * The order is a wire contract: `r:{hash}:{index}`. Never sort, dedupe or edit.
 *
 * MIT License
 *
 * Copyright (c) 2025 zjs81
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const MESHCORE_OPEN_REACTION_EMOJIS: readonly string[] = [
  // quickEmojis (0x00-0x05)
  '\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F389}', '\u{1F44F}', '\u{1F525}', // 👍 ❤️ 😂 🎉 👏 🔥
  // smileys (0x06-0x45)
  '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F605}', '\u{1F602}', // 😀 😃 😄 😁 😅 😂
  '\u{1F923}', '\u{1F60A}', '\u{1F607}', '\u{1F642}', '\u{1F643}', '\u{1F609}', // 🤣 😊 😇 🙂 🙃 😉
  '\u{1F60C}', '\u{1F60D}', '\u{1F970}', '\u{1F618}', '\u{1F617}', '\u{1F619}', // 😌 😍 🥰 😘 😗 😙
  '\u{1F61A}', '\u{1F60B}', '\u{1F61B}', '\u{1F61D}', '\u{1F61C}', '\u{1F92A}', // 😚 😋 😛 😝 😜 🤪
  '\u{1F928}', '\u{1F9D0}', '\u{1F913}', '\u{1F60E}', '\u{1F978}', '\u{1F929}', // 🤨 🧐 🤓 😎 🥸 🤩
  '\u{1F973}', '\u{1F60F}', '\u{1F612}', '\u{1F61E}', '\u{1F614}', '\u{1F61F}', // 🥳 😏 😒 😞 😔 😟
  '\u{1F615}', '\u{1F641}', '\u{1F623}', '\u{1F616}', '\u{1F62B}', '\u{1F629}', // 😕 🙁 😣 😖 😫 😩
  '\u{1F97A}', '\u{1F622}', '\u{1F62D}', '\u{1F624}', '\u{1F620}', '\u{1F621}', // 🥺 😢 😭 😤 😠 😡
  '\u{1F92C}', '\u{1F92F}', '\u{1F633}', '\u{1F975}', '\u{1F976}', '\u{1F631}', // 🤬 🤯 😳 🥵 🥶 😱
  '\u{1F628}', '\u{1F630}', '\u{1F625}', '\u{1F613}', '\u{1F917}', '\u{1F914}', // 😨 😰 😥 😓 🤗 🤔
  '\u{1F92D}', '\u{1F92B}', '\u{1F925}', '\u{1F636}', // 🤭 🤫 🤥 😶
  // gestures (0x46-0x66)
  '\u{1F44D}', '\u{1F44E}', '\u{1F44A}', '\u270A', '\u{1F91B}', '\u{1F91C}', // 👍 👎 👊 ✊ 🤛 🤜
  '\u{1F91E}', '\u270C\uFE0F', '\u{1F91F}', '\u{1F918}', '\u{1F44C}', '\u{1F90C}', // 🤞 ✌️ 🤟 🤘 👌 🤌
  '\u{1F90F}', '\u{1F448}', '\u{1F449}', '\u{1F446}', '\u{1F447}', '\u261D\uFE0F', // 🤏 👈 👉 👆 👇 ☝️
  '\u{1F44B}', '\u{1F91A}', '\u{1F590}\uFE0F', '\u270B', '\u{1F596}', '\u{1F44F}', // 👋 🤚 🖐️ ✋ 🖖 👏
  '\u{1F64C}', '\u{1F450}', '\u{1F932}', '\u{1F91D}', '\u{1F64F}', '\u270D\uFE0F', // 🙌 👐 🤲 🤝 🙏 ✍️
  '\u{1F485}', '\u{1F933}', '\u{1F4AA}', // 💅 🤳 💪
  // hearts (0x67-0x86)
  '\u2764\uFE0F', '\u{1F9E1}', '\u{1F49B}', '\u{1F49A}', '\u{1F499}', '\u{1F49C}', // ❤️ 🧡 💛 💚 💙 💜
  '\u{1F5A4}', '\u{1F90D}', '\u{1F90E}', '\u{1F494}', '\u2764\uFE0F\u200D\u{1F525}', '\u2764\uFE0F\u200D\u{1FA79}', // 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹
  '\u{1F495}', '\u{1F49E}', '\u{1F493}', '\u{1F497}', '\u{1F496}', '\u{1F498}', // 💕 💞 💓 💗 💖 💘
  '\u{1F49D}', '\u{1F49F}', '\u{1F48C}', '\u{1F4A2}', '\u{1F4A5}', '\u{1F4AB}', // 💝 💟 💌 💢 💥 💫
  '\u{1F4A6}', '\u{1F4A8}', '\u{1F573}\uFE0F', '\u{1F4AC}', '\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F', '\u{1F5E8}\uFE0F', // 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️
  '\u{1F5EF}\uFE0F', '\u{1F4AD}', // 🗯️ 💭
  // objects (0x87-0xb7)
  '\u{1F389}', '\u{1F38A}', '\u{1F388}', '\u{1F381}', '\u{1F380}', '\u{1FA85}', // 🎉 🎊 🎈 🎁 🎀 🪅
  '\u{1FA86}', '\u{1F3C6}', '\u{1F947}', '\u{1F948}', '\u{1F949}', '\u26BD', // 🪆 🏆 🥇 🥈 🥉 ⚽
  '\u26BE', '\u{1F94E}', '\u{1F3C0}', '\u{1F3D0}', '\u{1F3C8}', '\u{1F3C9}', // ⚾ 🥎 🏀 🏐 🏈 🏉
  '\u{1F3BE}', '\u{1F94F}', '\u{1F3B3}', '\u{1F3CF}', '\u{1F3D1}', '\u{1F3D2}', // 🎾 🥏 🎳 🏏 🏑 🏒
  '\u{1F94D}', '\u{1F3D3}', '\u{1F3F8}', '\u{1F94A}', '\u{1F94B}', '\u{1F945}', // 🥍 🏓 🏸 🥊 🥋 🥅
  '\u26F3', '\u{1F525}', '\u2B50', '\u{1F31F}', '\u2728', '\u26A1', // ⛳ 🔥 ⭐ 🌟 ✨ ⚡
  '\u{1F4A1}', '\u{1F526}', '\u{1F3EE}', '\u{1FA94}', '\u{1F4F1}', '\u{1F4BB}', // 💡 🔦 🏮 🪔 📱 💻
  '\u231A', '\u{1F4F7}', '\u{1F4FA}', '\u{1F4FB}', '\u{1F3B5}', '\u{1F3B6}', // ⌚ 📷 📺 📻 🎵 🎶
  '\u{1F680}', // 🚀
];
