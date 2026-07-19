const UI_GLYPH_PATTERN = /(?:\p{Extended_Pictographic}|[★☆✓✔✕✖✗⚠ℹ▶◀▲▼→←↑↓])/u;

export function containsHardcodedUiGlyph(value) {
  return typeof value === 'string' && UI_GLYPH_PATTERN.test(value);
}

export const noHardcodedUiGlyph = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require app-owned interface glyphs to use the shared UiIcon registry.',
    },
    schema: [],
    messages: {
      hardcoded: 'Hardcoded UI glyph detected. Use <UiIcon name="…" />; add an issue-referenced disable only for domain or user content.',
    },
  },
  create(context) {
    const report = (node, value) => {
      if (containsHardcodedUiGlyph(value)) {
        context.report({ node, messageId: 'hardcoded' });
      }
    };

    return {
      Literal(node) {
        report(node, node.value);
      },
      JSXText(node) {
        report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.raw);
      },
    };
  },
};

