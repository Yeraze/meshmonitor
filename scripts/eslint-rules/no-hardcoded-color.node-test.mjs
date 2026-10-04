import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import typescriptParser from '@typescript-eslint/parser';
import {
  findColorLiterals,
  isCssColorProperty,
  noHardcodedColor,
} from './no-hardcoded-color.mjs';

test('finds hex, rgb and hsl literals, bare or inside a shorthand', () => {
  assert.deepEqual(findColorLiterals('#1e1e2e'), ['#1e1e2e']);
  assert.deepEqual(findColorLiterals('#fff'), ['#fff']);
  assert.deepEqual(findColorLiterals('#ffff'), ['#ffff']);
  assert.deepEqual(findColorLiterals('#11223344'), ['#11223344']);
  assert.deepEqual(findColorLiterals('2px solid #3a3a3a'), ['#3a3a3a']);
  assert.deepEqual(findColorLiterals('rgba(0, 0, 0, 0.5)'), ['rgba(0, 0, 0, 0.5)']);
  assert.deepEqual(findColorLiterals('0 2px 4px rgb(0 0 0 / 20%)'), ['rgb(0 0 0 / 20%)']);
  assert.deepEqual(findColorLiterals('hsl(210, 50%, 40%)'), ['hsl(210, 50%, 40%)']);
  assert.deepEqual(findColorLiterals('hsla(210 50% 40% / 0.5)'), ['hsla(210 50% 40% / 0.5)']);
  // A nested call inside a colour function: the span ends at the function's
  // own closing paren, not the inner one and not a later one.
  assert.deepEqual(
    findColorLiterals('0 2px rgba(0, calc(255 * 0.5), min(1, 2), 1) 4px, 0 0 (x)'),
    ['rgba(0, calc(255 * 0.5), min(1, 2), 1)'],
  );
  assert.deepEqual(
    findColorLiterals('linear-gradient(#000, rgba(1,2,3,.4) 50%, #fff)'),
    ['#000', 'rgba(1,2,3,.4)', '#fff'],
  );
});

test('ignores tokens, keywords, ids and other look-alikes', () => {
  for (const value of [
    'var(--color-surface)',
    '1px solid var(--color-border)',
    'color-mix(in srgb, var(--color-info) 15%, var(--color-surface))',
    // Derived from a token, so it follows the theme.
    'rgb(from var(--color-accent) r g b / 50%)',
    'transparent',
    'currentColor',
    'inherit',
    '#section',
    '#notif-services',
    '#12', // too short
    '#12345', // not a colour length
    '#1234567', // not a colour length
    '&#10;', // HTML entity
    'Hi&#10;Help',
    '',
  ]) {
    assert.deepEqual(findColorLiterals(value), [], value);
  }
  assert.deepEqual(findColorLiterals(42), []);
  assert.deepEqual(findColorLiterals(null), []);
});

test('knows which properties take a colour', () => {
  for (const name of [
    'color',
    'background',
    'backgroundColor',
    'backgroundImage',
    'border',
    'borderTop',
    'borderLeftColor',
    'borderInlineStart',
    'borderBlockEndColor',
    'outline',
    'outlineColor',
    'boxShadow',
    'textShadow',
    'caretColor',
    'accentColor',
    'textDecorationColor',
    'columnRule',
  ]) {
    assert.equal(isCssColorProperty(name), true, name);
  }
  for (const name of [
    'id',
    'label',
    'href',
    'content',
    'width',
    'borderRadius',
    'borderWidth',
    'backgroundSize',
    'colorScheme',
    // SVG / drawing vocabulary, out of scope.
    'fill',
    'stroke',
    'fillColor',
    'lineColor',
    'line-color',
    // Kebab-case is not a React style key; MapLibre paint uses it.
    'background-color',
  ]) {
    assert.equal(isCssColorProperty(name), false, name);
  }
});

const ruleTester = new RuleTester({
  languageOptions: {
    parser: typescriptParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const hit = (code, count = 1) => ({
  code,
  errors: Array.from({ length: count }, () => ({ messageId: 'hardcoded' })),
});

const VALID = [
  // Tokens and keywords.
  `const a = <div style={{ color: 'var(--color-text)' }} />;`,
  `const a = <div style={{ border: '1px solid var(--color-border)' }} />;`,
  `const a = <div style={{ background: 'transparent', color: 'currentColor', borderColor: 'inherit' }} />;`,
  `const a = <div style={{ background: 'color-mix(in srgb, var(--color-info) 15%, var(--color-surface))' }} />;`,
  'const a = <div style={{ border: `1px solid var(--color-${role})` }} />;',
  // A colour built at runtime from data is not a literal.
  'const a = <div style={{ color: `#${hex}` }} />;',
  'const a = <div style={{ background: `rgb(${c.r}, ${c.g}, ${c.b})` }} />;',
  'const a = <div style={{ background: `linear-gradient(to right, hsl(${hue} ${s}% ${l}%), var(--color-accent))` }} />;',
  `const a = <div style={{ color: node.color }} />;`,
  // Non-colour properties, in and out of a style attribute.
  `const a = <div style={{ width: '100%', padding: '12px', borderRadius: '6px' }} />;`,
  `const nav = { id: '#section', href: '#notif-services', label: '#fff' };`,
  `const options = { content: 'rgb(1, 2, 3)', title: '#000000' };`,
  // SVG presentation attributes.
  `const a = <path fill="#ffffff" stroke="#000" />;`,
  `const a = <circle fill={'#ff0000'} stopColor="#00ff00" />;`,
  // Other attributes and plain strings.
  `const a = <a href="#section" id="#abc">x</a>;`,
  `const a = <textarea placeholder="Hi&#10;Help" />;`,
  `const palette = ['#ff0000', '#00ff00'];`,
  `const fallback = '#888888';`,
  `callSomething({ value: '#123456' });`,
  // Map / canvas / chart drawing options need a concrete colour.
  `const pathOptions = { color: '#3388ff', weight: 2, fillColor: '#3388ff', fillOpacity: 0.2 };`,
  `const a = <Polyline pathOptions={{ color: '#ff0000', weight: 3 }} />;`,
  `const paint = { 'background-color': '#f8f8f8', 'line-color': '#000' };`,
  // Palette records: a chart series or legend entry carries colour as data.
  `const SERIES = [{ key: 'rx', label: 'Received', color: '#a6e3a1' }, { type: 'mc_snr', unit: 'dB', color: '#89b4fa' }];`,
  `const legend = { name: 'Direct', color: 'rgb(0, 200, 0)' };`,
  // A variable named *Style is not proof of CSS: this one is Leaflet's.
  `const ringStyle = { color: '#38bdf8', weight: 3, fillColor: '#38bdf8', fillOpacity: 0.15 };`,
  `const waterStyle = { paint: { 'fill-color': '#a0c8f0' } };`,
  // Only the CSSProperties type itself marks a style context.
  `const box: NoCSSPropertiesHere = { color: '#fff' };`,
  // A bare `color` key outside a style context is not known to be CSS.
  `const s = { color: '#ff0000' };`,
  `const s = { color: (dark ? '#fff' : '#000') as string };`,
  // The colour is in a condition, not a value.
  `const s = { color: theme === '#fff' ? 'var(--color-text)' : 'inherit' };`,
  // Computed keys are not known to be colour properties.
  `const s = { [key]: '#ffffff' };`,
  // A call result is not the literal itself.
  `const s = { color: pick('#ffffff') };`,
];

const INVALID = [
  // Bare hex.
  hit(`const a = <div style={{ backgroundColor: '#1e1e2e' }} />;`),
  hit(`const a = <div style={{ color: '#fff' }} />;`),
  // Hex inside a shorthand string.
  hit(`const a = <div style={{ border: '2px solid #3a3a3a' }} />;`),
  // rgba / rgb / hsl / hsla.
  hit(`const a = <div style={{ boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)' }} />;`),
  hit(`const a = <div style={{ color: 'rgb(255 0 0)' }} />;`),
  hit(`const a = <div style={{ color: 'hsl(210, 50%, 40%)' }} />;`),
  hit(`const a = <div style={{ background: 'hsla(210, 50%, 40%, 0.5)' }} />;`),
  // Template literal.
  hit('const a = <div style={{ border: `${width}px solid #3a3a3a` }} />;'),
  hit('const a = <div style={{ background: `rgba(0, 0, 0, ${alpha})` }} />;'),
  // Conditional and concatenated values: each literal reports.
  hit(`const a = <div style={{ color: on ? '#10b981' : '#3a3a3a' }} />;`, 2),
  hit(`const a = <div style={{ border: '2px solid ' + (on ? '#10b981' : '#3a3a3a') }} />;`, 2),
  hit('const a = <div style={{ border: `2px solid ${on ? "#10b981" : "#3a3a3a"}` }} />;', 2),
  // Two colours in one literal is one report.
  hit(`const a = <div style={{ background: 'linear-gradient(#000, #fff)' }} />;`),
  // Nested style object and spread branches under a style attribute.
  hit(`const a = <div style={{ ...(on ? { background: '#252535' } : {}), padding: 4 }} />;`),
  hit(`const a = <Box style={{ header: { color: '#ffffff' } }} />;`),
  // `*Style` attributes are DOM styles too (chart tooltips and the like).
  hit(`const a = <Tooltip contentStyle={{ backgroundColor: '#1e1e2e' }} labelStyle={{ color: '#cdd6f4' }} />;`, 2),
  // Any literal under `style`, whatever the key.
  hit(`const a = <div style={{ filter: 'drop-shadow(0 0 2px #000)' }} />;`),
  // A token with a literal fallback still carries the literal.
  hit(`const a = <div style={{ color: 'var(--text-muted, #888)' }} />;`),
  // Style objects built outside the JSX, caught by their colour-property key.
  hit(`const card = { backgroundColor: '#252535', padding: '12px' };`),
  hit(`const look = { card: { border: '1px solid #3a3a3a' }, title: { boxShadow: '0 0 2px rgb(1,2,3)' } };`, 2),
  hit(`const s = { outline: fallback || '1px solid #f00' };`),
  hit(`const s = { borderLeft: (dark ? '3px solid #fff' : '3px solid #000') as string };`, 2),
  // A variable typed CSSProperties is a style context: every literal in it
  // counts, a bare `color` included.
  hit(`const box: React.CSSProperties = { color: '#fff' };`),
  hit(`const box: Partial<CSSProperties> = { color: '#fff' };`),
  hit(`const box: CSSProperties = { color: dark ? '#fff' : '#000' };`, 2),
];

test('rule passes tokens, keywords, non-colour properties, SVG attributes and colour held as data', () => {
  ruleTester.run('no-hardcoded-color', noHardcodedColor, { valid: VALID, invalid: [] });
});

test('rule reports hex, rgb and hsl literals in inline styles and style objects', () => {
  ruleTester.run('no-hardcoded-color', noHardcodedColor, { valid: [], invalid: INVALID });
});

test('the report names the literal and the way out', () => {
  ruleTester.run('no-hardcoded-color', noHardcodedColor, {
    valid: [],
    invalid: [
      {
        code: 'const a = <div style={{ background: `rgba(0, 0, 0, ${alpha})` }} />;',
        errors: [{ messageId: 'hardcoded', data: { literal: 'rgba(0, 0, 0, ${…})' } }],
      },
      {
        code: `const a = <div style={{ border: '1px solid #3a3a3a' }} />;`,
        errors: [{ messageId: 'hardcoded', data: { literal: '#3a3a3a' } }],
      },
    ],
  });
});
