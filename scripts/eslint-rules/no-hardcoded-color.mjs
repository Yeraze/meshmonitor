// #5594: a hex / rgb() / hsl() literal in an inline style bypasses the
// `--color-*` role tokens in src/App.css, so the element keeps one theme's
// colour under every theme. That is the root cause of #5592, #5558, #5247,
// #5135 and #4910 — dark panels in light mode, each found in production.
//
// Scope, on purpose narrow:
//   1. any string or template literal under a JSX `style` attribute;
//   2. the value of an object property keyed by a CSS colour property
//      (`backgroundColor`, `border`, `boxShadow`, ...), wherever the object
//      lives, since style objects are often built outside the JSX.
//
// Not in scope: SVG presentation attributes (`fill="#fff"`), and drawing
// options for canvas / map / chart libraries, which need a concrete colour
// because a CSS variable does not resolve there. Those are recognised by a
// sibling key no CSS style object has (`fillColor`, `weight`, ...).

const HEX = String.raw`(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])`;
const FUNCTION_OPEN = /\b(?:rgb|rgba|hsl|hsla)\(/g;
const HEX_PATTERN = new RegExp(HEX, 'g');

/**
 * Colour literals in a string: hex (3, 4, 6 or 8 digits) and rgb()/rgba()/
 * hsl()/hsla() calls. A colour function whose arguments reference a custom
 * property (`rgb(from var(--color-accent) r g b / 50%)`) is derived from a
 * token and is not counted.
 *
 * @param {unknown} value
 * @returns {string[]} the matched literals, in order
 */
export function findColorLiterals(value) {
  if (typeof value !== 'string') return [];
  const found = [];
  for (const m of value.matchAll(HEX_PATTERN)) found.push({ at: m.index, text: m[0] });
  for (const m of value.matchAll(FUNCTION_OPEN)) {
    // Walk to the matching close paren so nested var()/calc() are kept whole.
    let depth = 0;
    let end = value.length;
    for (let i = m.index + m[0].length - 1; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const call = value.slice(m.index, end);
    if (!call.includes('var(--')) found.push({ at: m.index, text: call });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.text);
}

const COLOR_PROPERTY = new RegExp(
  '^(?:' +
    [
      'color',
      'background(?:Color|Image)?',
      'border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?(?:Color)?',
      'outline(?:Color)?',
      '(?:box|text)Shadow',
      'caretColor',
      'accentColor',
      'textDecoration(?:Color)?',
      'columnRule(?:Color)?',
    ].join('|') +
    ')$',
);

/** `background-color` and `backgroundColor` are the same property. */
export function isCssColorProperty(name) {
  if (typeof name !== 'string') return false;
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return COLOR_PROPERTY.test(camel);
}

// Keys that mark an object as drawing options for Leaflet, MapLibre, canvas or
// a chart library rather than a CSS style object.
const DRAWING_OPTION_KEYS = new Set([
  'fillColor',
  'fillOpacity',
  'weight',
  'dashArray',
  'dashOffset',
  'lineCap',
  'lineJoin',
  'radius',
  'stroke',
  'strokeColor',
  'strokeOpacity',
  'strokeWidth',
  'strokeDasharray',
  'pointRadius',
  'tension',
]);

function keyName(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return null;
}

function isDrawingOptions(objectExpression) {
  return objectExpression.properties.some(
    (p) => p.type === 'Property' && DRAWING_OPTION_KEYS.has(keyName(p)),
  );
}

// Wrappers a literal can sit in and still be "the value" of its property:
// `cond ? '#fff' : '#000'`, `a || '#fff'`, `'1px solid ' + '#fff'`, a template
// interpolation, a TS cast.
function passesValueThrough(parent, child) {
  switch (parent.type) {
    case 'ConditionalExpression':
      return parent.test !== child;
    case 'LogicalExpression':
    case 'TemplateLiteral':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return true;
    case 'BinaryExpression':
      return parent.operator === '+';
    default:
      return false;
  }
}

export const noHardcodedColor = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require inline styles to take colours from the --color-* role tokens.',
    },
    schema: [],
    messages: {
      hardcoded:
        'Hardcoded colour {{literal}}. Use a --color-* role token (var(--color-surface), var(--color-border), ...; see src/App.css), ideally in a CSS module. For a colour that is data, not theme: eslint-disable-next-line meshmonitor-ui/no-hardcoded-color -- #<issue> <reason>.',
    },
  },
  create(context) {
    const inColorContext = (node) => {
      const ancestors = context.sourceCode.getAncestors(node);

      const underStyleAttribute = ancestors.some(
        (a) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === 'style',
      );
      if (underStyleAttribute) return true;

      let child = node;
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const parent = ancestors[i];
        if (parent.type === 'Property') {
          if (parent.value !== child || !isCssColorProperty(keyName(parent))) return false;
          const owner = ancestors[i - 1];
          return owner?.type === 'ObjectExpression' && !isDrawingOptions(owner);
        }
        if (!passesValueThrough(parent, child)) return false;
        child = parent;
      }
      return false;
    };

    const check = (node, text) => {
      const literals = findColorLiterals(text);
      if (literals.length === 0 || !inColorContext(node)) return;
      context.report({ node, messageId: 'hardcoded', data: { literal: literals.join(', ') } });
    };

    return {
      Literal(node) {
        check(node, node.value);
      },
      // One report per template, on the static text only: an interpolated
      // literal (`${on ? '#fff' : '#000'}`) is its own node and reports itself.
      // Quasis are joined with a space so `#${hex}` does not read as a colour.
      TemplateLiteral(node) {
        check(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' '));
      },
    };
  },
};
