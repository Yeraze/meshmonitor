import { describe, it, expect } from 'vitest';
import {
  MC_REACTION_FORMAT_VERSION,
  buildMc1ChannelReaction,
  buildMc1DmReaction,
  dartStringHash,
  isReactionEmoji,
  isReactionText,
  mc1ChannelBody,
  mc1ReactionHash,
  meshcoreOpenV3Hash,
  normalizeMc1ReactionHash,
  parseMc1ChannelReaction,
  parseMc1DmReaction,
  parseMeshCoreOpenReaction,
  parseMeshCoreReaction,
} from './meshcoreReactions.js';
import { MESHCORE_OPEN_REACTION_EMOJIS as TABLE } from './meshcoreOpenEmojiTable.js';
import { sha256PureJS } from './meshcoreHelpers.js';

const H = 'a1b2c3d4';
const HEART = '❤️';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const ONE_KEYCAP = '1️⃣';
const THUMB_VS = '\u{1F44D}️';

// Every parse input below is also fed to the superset property test.
const parseInputs: string[] = [];

describe('mc1ReactionHash', () => {
  it.each([
    ['Hello', 1704067200, 'b45pc4ek'],
    ['Hello world', 1704067200, '7a6r3xy1'],
    ['Hello', 1704067201, '3wh8x8z5'],
    ['World', 1704067200, 'vp1vxnf4'],
    ['Message 0', 0, '7mt5pe1m'],
    ['café 👍 ok', 1760000000, '8b5qzwf6'],
    ['', 4294967295, 'npah66y0'],
    ['Hello world!', 1234567890, 'tyvbkb33'],
    ['', 0, 'vwzp3604'],
    ['Hello', 4294967295, 'vs4bnq2w'],
    ['line1\r\nline2', 1704067200, 'ynzeazsh'],
    ['👍', 1704067200, 'z5kxjbn0'],
    ['a\uD800b', 1, '29htgvj2'],
    ['a�b', 1, '29htgvj2'],
  ])('hash(%j, %i) = %s', (text, ts, hash) => {
    expect(mc1ReactionHash(text, ts)).toBe(hash);
  });

  it.each([-1, 4294967296, 1.5, NaN])('returns null for timestamp %s', (ts) => {
    expect(mc1ReactionHash('Hello', ts)).toBeNull();
  });

  it('always yields 8 chars from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(mc1ReactionHash(`msg ${i}`, i * 7919)).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    }
  });
});

describe('normalizeMc1ReactionHash', () => {
  it.each([
    ['b45pc4ek', 'b45pc4ek'],
    ['B45PC4EK', 'b45pc4ek'],
    ['ABCDEFG1', 'abcdefg1'],
    ['OOOOOOOO', '00000000'],
    ['iiiiiiii', '11111111'],
    ['LLLLLLLL', '11111111'],
    ['oIlLiO0o', '01111000'],
    ['received', 'rece1ved'],
    ['password', 'passw0rd'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeMc1ReactionHash(input)).toBe(out);
  });

  it.each([
    'uuuuuuuu', 'b45pc4eU', 'abc', 'abcd12345', '', 'abcd-123', 'abcdefgé', ' b45pc4e',
    '１２３４５６７８',
  ])('refuses %j', (input) => {
    expect(normalizeMc1ReactionHash(input)).toBeNull();
  });
});

describe('isReactionEmoji', () => {
  it.each([
    '👍', HEART, '❤', '👍🏽', FAMILY, '🇺🇸', '🇺', '©️', ONE_KEYCAP, '#⃣',
    '⌚️', '⌨️', '⏩', '⏏', '☺', '☝️', '✊',
    '\u{1F3FB}', THUMB_VS, '1́', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  ])('accepts %j', (v) => {
    expect(isReactionEmoji(v)).toBe(true);
  });

  it.each([
    '', '1', '#', '*', 'A', 'é', '中', '©', '®', '™', '‼', '⌚', '⌛', '⌨',
    '⎌', '‍', '️', '👍👍', '👍 ', ' 👍', '👍\r', '🎉 on my way', '\uD83D', '\uDC4D',
    '\uD83Dx',
  ])('refuses %j', (v) => {
    expect(isReactionEmoji(v)).toBe(false);
  });

  it('accepts every table entry except index 0xb1', () => {
    TABLE.forEach((e, i) => {
      expect(isReactionEmoji(e), `index ${i}`).toBe(i !== 0xb1);
    });
  });
});

describe('parseMc1ChannelReaction', () => {
  const ok = (text: string, exp: Record<string, string>) => {
    parseInputs.push(text);
    expect(parseMc1ChannelReaction(text)).toMatchObject(exp);
  };

  it('parses current order', () => {
    ok('@[AlphaNode]👍\n7f3a9c12', { format: 'mc1-channel', emoji: '👍', targetSender: 'AlphaNode', hash: '7f3a9c12' });
    ok(`@[BetaNode]${HEART}\ne4d8b1a0`, { format: 'mc1-channel', emoji: HEART, targetSender: 'BetaNode', hash: 'e4d8b1a0' });
  });

  it('folds the hash', () => {
    ok('@[Node]👍\nABCDEF12', { hash: 'abcdef12' });
    ok('@[Node]👍\nOOOOOOOO', { hash: '00000000' });
    ok('@[Node]👍\niiiiiiii', { hash: '11111111' });
    ok('@[Node]👍\nLLLLLLLL', { hash: '11111111' });
    ok('@[Alice]👍\nreceived', { hash: 'rece1ved' });
  });

  it('tolerates a space separator before the hash (#6039)', () => {
    // Some firmware/transport hands our own channel-reaction echo back with the
    // `\n` turned into a space; the channel parser must still fold it.
    ok('@[AlphaNode]👍 7f3a9c12', { format: 'mc1-channel', emoji: '👍', targetSender: 'AlphaNode', hash: '7f3a9c12' });
    ok('@[ERA-3 (SI)]👍 7f3a9c12', { format: 'mc1-channel', emoji: '👍', targetSender: 'ERA-3 (SI)', hash: '7f3a9c12' });
    ok('👍@[AlphaNode] 7f3a9c12', { format: 'mc1-channel-legacy', emoji: '👍', targetSender: 'AlphaNode', hash: '7f3a9c12' });
  });

  it('parses legacy order', () => {
    ok('👍@[AlphaNode]\n7f3a9c12', { format: 'mc1-channel-legacy', emoji: '👍', targetSender: 'AlphaNode' });
    ok(`👍@[a]b]\n${H}`, { format: 'mc1-channel-legacy', targetSender: 'a]b' });
    ok(`👍@[A]@[B]\n${H}`, { format: 'mc1-channel-legacy', targetSender: 'A]@[B' });
  });

  it('keeps the sender verbatim', () => {
    ok(`@[Node:Alpha]👍\n${H}`, { targetSender: 'Node:Alpha' });
    ok(`@[a[b]👍\n${H}`, { targetSender: 'a[b' });
    ok(`@[x@[y]👍\n${H}`, { targetSender: 'x@[y' });
    ok(`@[ Node ]👍\n${H}`, { targetSender: ' Node ' });
    ok(`@[No\nde]👍\n${H}`, { targetSender: 'No\nde' });
    ok(`@[Node\uD800]👍\n${H}`, { targetSender: 'Node\uD800' });
  });

  it('returns the emoji whole', () => {
    ok(`@[Node]👍🏽\n${H}`, { emoji: '👍🏽' });
    ok(`@[Node]${FAMILY}\n${H}`, { emoji: FAMILY });
    ok(`@[Node]🇺🇸\n${H}`, { emoji: '🇺🇸' });
    ok(`@[Node]${ONE_KEYCAP}\n${H}`, { emoji: ONE_KEYCAP });
    ok(`@[Node]❤\n${H}`, { emoji: '❤' });
    ok(`@[Node]${THUMB_VS}\n${H}`, { emoji: THUMB_VS });
  });

  it.each([
    'Just a normal message', '@[Node]👍', `👍 [Node]\n${H}`, `👍@Node\n${H}`, '@[Node]👍\nabc',
    '@[Node]👍\nuuuuuuuu', '@[Node]👍\na1b2-3d4', `@[]👍\n${H}`, `👍@[]\n${H}`, `@[Node]\n${H}`,
    '@[Alice]🎉 on my way\npassword', '🎉 on my way@[Alice]\npassword', `A@[Node]\n${H}`,
    `@[Node]1\n${H}`, `@[a]b]👍\n${H}`, `@[A]👍@[B]\n${H}`, `@[Node]👍\r\n${H}`,
    `@[Node]👍\n${H}\r`, `@[Node]👍\n${H}\n`, `@[Node]👍\n\n${H}`, ` @[Node]👍\n${H}`,
    `@[Node] 👍\n${H}`, '👍\n7f3a9c12', '', '\n',
    // #6039 space-separator tolerance must stay channel-shaped: no `@[` marker,
    // a space before the emoji, or a non-hash tail is still refused.
    'chatting about abcd1234', '@[Node] 👍 abcd1234', '@[Node]👍 toolongforhash',
  ])('refuses %j', (text) => {
    parseInputs.push(text);
    expect(parseMc1ChannelReaction(text)).toBeNull();
  });
});

describe('parseMc1DmReaction', () => {
  it.each([
    ['👍\n7f3a9c12', '👍', '7f3a9c12'],
    [`${HEART}\ne4d8b1a0`, HEART, 'e4d8b1a0'],
    ['👍\nABCDEF12', '👍', 'abcdef12'],
    [`👍🏽\n${H}`, '👍🏽', H],
    ['👍\nreceived', '👍', 'rece1ved'],
  ])('parses %j', (text, emoji, hash) => {
    parseInputs.push(text);
    expect(parseMc1DmReaction(text)).toEqual({ format: 'mc1-dm', emoji, hash });
  });

  it.each([
    '👍', '@[Node]👍\nabcd1234', `👍@[\n${H}`, `👍\nuuuuuuuu`, `A\n${H}`, `1\n${H}`,
    'ok\nreceived', '🎉 on my way\npassword', `👍\r\n${H}`, `👍\n\n${H}`, `\n${H}`, '',
    // #6039 relaxes the CHANNEL parser only: a DM reaction still needs the `\n`
    // separator, so a space form stays a plain message here.
    '👍 7f3a9c12', `${HEART} a1b2c3d4`,
  ])('refuses %j', (text) => {
    parseInputs.push(text);
    expect(parseMc1DmReaction(text)).toBeNull();
  });
});

describe('build and round trip', () => {
  it('builds the wire text', () => {
    const h = mc1ReactionHash('Hello', 1704067200) as string;
    expect(buildMc1ChannelReaction('AlphaNode', '👍', h)).toBe('@[AlphaNode]👍\nb45pc4ek');
    expect(buildMc1DmReaction('👍', 'b45pc4ek')).toBe('👍\nb45pc4ek');
    expect(buildMc1ChannelReaction('Node', '👍', 'B45PC4EK')?.endsWith('b45pc4ek')).toBe(true);
  });

  it.each([
    ['', '👍', H], ['a]b', '👍', H], ['a\nb', '👍', H],
    ['Node', '1', H], ['Node', 'ok', H], ['Node', '👍👍', H], ['Node', '', H],
    ['Node', '👍', 'abc'], ['Node', '👍', 'uuuuuuuu'],
  ])('refuses to build channel (%j, %j, %j)', (s, e, h) => {
    expect(buildMc1ChannelReaction(s, e, h)).toBeNull();
  });

  it('refuses to build a bad DM', () => {
    expect(buildMc1DmReaction('ok', H)).toBeNull();
    expect(buildMc1DmReaction('👍', 'abc')).toBeNull();
  });

  const senders = ['AlphaNode', 'Node:Alpha', 'a[b', ' Node ', 'Ünï 中'];
  const emoji = ['👍', HEART, '👍🏽', FAMILY, '🇺🇸', ONE_KEYCAP];
  for (const s of senders) {
    for (const e of emoji) {
      it(`round trips ${JSON.stringify(s)} ${e}`, () => {
        const ch = buildMc1ChannelReaction(s, e, H) as string;
        parseInputs.push(ch);
        expect(parseMc1ChannelReaction(ch)).toEqual({ format: 'mc1-channel', emoji: e, targetSender: s, hash: H });
        expect(parseMc1DmReaction(ch)).toBeNull();
        const dm = buildMc1DmReaction(e, H) as string;
        parseInputs.push(dm);
        expect(parseMc1DmReaction(dm)).toEqual({ format: 'mc1-dm', emoji: e, hash: H });
        expect(parseMc1ChannelReaction(dm)).toBeNull();
      });
    }
  }
});

describe('mc1ChannelBody', () => {
  it('takes text after the first colon and trims spaces and tabs only', () => {
    expect(mc1ChannelBody('Alice: Hello')).toBe('Hello');
    expect(mc1ChannelBody('Alice: a: b')).toBe('a: b');
    expect(mc1ChannelBody('Alice: \t hi \t ')).toBe('hi');
    expect(mc1ChannelBody('Alice:\nhi\n')).toBe('\nhi\n');
    expect(mc1ChannelBody('  no colon  ')).toBe('no colon');
  });
});

describe('dartStringHash', () => {
  it.each([
    ['', 1],
    ['\u0000', 1],
    ['a', 170824770],
    ['1700000000Bobhello', 542107513],
    ['1700000000hi', 963884477],
    ['Bob', 124362681],
    ['hello', 150804507],
    ['Alice', 210078619],
    ['Hello world', 780881625],
  ])('hash(%j) = %i', (s, n) => {
    expect(dartStringHash(s)).toBe(n);
  });

  it('stays in 1..0x3FFFFFFF', () => {
    for (let i = 0; i < 500; i++) {
      const h = dartStringHash(`s${i}${'x'.repeat(i % 17)}`);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(0x3fffffff);
    }
  });
});

describe('meshcoreOpenV3Hash', () => {
  it.each([
    [1700000000, 'Bob', 'hello', 'e779'],
    [1700000000, null, 'hi', 'b5bd'],
    [1700000000, 'Привет😀', 'x', '7fee'],
    [1234567890, 'Alice', 'Hello world', 'a51e'],
    [1704067200, 'AlphaNode', 'Hello', '6df6'],
    [1704067200, null, 'Hello', '92c7'],
    [0, 'A', '', '4bd9'],
    [4294967295, 'A', '', 'fd84'],
    [1704067200, 'A', 'abcd😀', '917f'],
    [1704067200, 'A', 'abcd\uD83D', '917f'],
    [1704067200, 'A', 'abcdefgh', '39f3'],
    [1704067200, 'A', 'abcde', '39f3'],
    [1704067200, 'a]b:c', 'hey', 'f04f'],
    [1704067200, '', 'hey', '0be1'],
  ])('(%i, %j, %j) = %s', (ts, name, text, hash) => {
    expect(meshcoreOpenV3Hash(ts, name, text)).toBe(hash);
  });

  it.each([-1, 1.5, NaN])('returns null for timestamp %s', (ts) => {
    expect(meshcoreOpenV3Hash(ts, 'A', 'x')).toBeNull();
  });
});

describe('parseMeshCoreOpenReaction', () => {
  it.each([
    ['r:a1b2:00', '👍', 0, 'a1b2'],
    ['r:e779:01', HEART, 1, 'e779'],
    ['r:a1b2:0b', '😂', 11, 'a1b2'],
    ['r:a1b2:46', '👍', 70, 'a1b2'],
    ['r:0000:b7', '🚀', 183, '0000'],
  ])('v3 %s', (text, emoji, emojiIndex, hash) => {
    parseInputs.push(text);
    expect(parseMeshCoreOpenReaction(text)).toEqual({ format: 'mco-v3', emoji, emojiIndex, hash });
  });

  it.each([
    ['r:1700000000000_12345_67890:👍', '👍', 12345, 67890, null],
    ['r:1700000000000_12345_67890:⌚', '⌚', 12345, 67890, null],
    [`r:1700000000000_a1b2c3d4:${HEART}`, HEART, null, null, 'a1b2c3d4'],
    ['r:1700000000000_12345678:👍', '👍', null, null, '12345678'],
  ])('v1 %s', (text, emoji, nameHash, textHash, prefix) => {
    parseInputs.push(text);
    expect(parseMeshCoreOpenReaction(text)).toEqual({
      format: 'mco-v1',
      emoji,
      timestampMs: 1700000000000,
      senderNameHash: nameHash,
      textHash,
      senderKeyPrefix: prefix,
    });
  });

  it.each([
    'r:ffff:b8', 'r:ffff:ff', 'r:A1B2:00', 'r:a1b2:0B', 'r:zzzz:00', 'r:a1b2:0', 'r:a1b2:000',
    'r:a1b2:00\n', ' r:a1b2:00', 'R:a1b2:00', 'r:12:34:5', 'r:hello:x', 'r: see me',
    'r:1700000000000_12345_67890:ok', 'r:1700000000000_12345_67890:👍👍', 'r:1700000000000:👍',
    'r:abc_def_ghi:👍',
  ])('refuses %j', (text) => {
    parseInputs.push(text);
    expect(parseMeshCoreOpenReaction(text)).toBeNull();
  });
});

describe('emoji table', () => {
  it('has the expected shape', () => {
    expect(TABLE.length).toBe(184);
    expect(new Set(TABLE).size).toBe(178);
    expect(TABLE[0]).toBe('\u{1F44D}');
    expect(TABLE[1]).toBe(HEART);
    expect(TABLE[0x66]).toBe('\u{1F4AA}');
    expect(TABLE[0x83]).toBe('\u{1F441}️‍\u{1F5E8}️');
    expect(TABLE[0xb1]).toBe('⌚');
    expect(TABLE[0xb7]).toBe('\u{1F680}');
  });

  it('matches the vendored digest', () => {
    const digest = sha256PureJS(new TextEncoder().encode(TABLE.join('\n')));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('7150024d68867be0191c8e1cec6fea1ba76c8bf656fd5327fe16658d04c134ee');
  });
});

describe('parseMeshCoreReaction and isReactionText', () => {
  it('routes by scope', () => {
    expect(parseMeshCoreReaction('@[AlphaNode]👍\n7f3a9c12', 'channel')?.format).toBe('mc1-channel');
    expect(parseMeshCoreReaction('👍@[AlphaNode]\n7f3a9c12', 'channel')?.format).toBe('mc1-channel-legacy');
    expect(parseMeshCoreReaction('r:a1b2:00', 'channel')?.format).toBe('mco-v3');
    expect(parseMeshCoreReaction('👍\n7f3a9c12', 'channel')).toBeNull();

    expect(parseMeshCoreReaction('👍\n7f3a9c12', 'dm')?.format).toBe('mc1-dm');
    expect(parseMeshCoreReaction('@[AlphaNode]👍\n7f3a9c12', 'dm')).toBeNull();
    expect(parseMeshCoreReaction('r:a1b2:00', 'dm')?.format).toBe('mco-v3');
    expect(parseMeshCoreReaction('r:1700000000000_12345_67890:👍', 'dm')?.format).toBe('mco-v1');
    expect(parseMeshCoreReaction('r:1700000000000_a1b2c3d4:👍', 'dm')?.format).toBe('mco-v1');
  });

  it.each([
    null, undefined, '', '\n', 'Just a normal message', '@[Node]👍', '👍', '@[Node]👍\nabc',
    `@[Node]👍\n${H}\r`, 'r:a1b2:0', ' r:a1b2:00', 'R:a1b2:00', `\n${H}`,
  ])('isReactionText is false for %j', (t) => {
    expect(isReactionText(t)).toBe(false);
  });

  it.each(['r:zzzz:00', 'r: see me', '@[Node]👍\nuuuuuuuu', 'ok\nreceived', `👍\n\n${H}`])(
    'isReactionText is true but parse is null for %j',
    (t) => {
      expect(isReactionText(t)).toBe(true);
      expect(parseMeshCoreReaction(t, 'channel')).toBeNull();
      expect(parseMeshCoreReaction(t, 'dm')).toBeNull();
    },
  );

  it('superset: a parse hit implies isReactionText', () => {
    expect(parseInputs.length).toBeGreaterThan(100);
    for (const t of parseInputs) {
      for (const scope of ['channel', 'dm'] as const) {
        if (parseMeshCoreReaction(t, scope) !== null) {
          expect(isReactionText(t), JSON.stringify(t)).toBe(true);
        }
      }
    }
  });

  it('exports the format version', () => {
    expect(MC_REACTION_FORMAT_VERSION).toBe(1);
  });
});
