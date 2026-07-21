const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
// Circle/slash status glyphs (●○◐◯⊘) were missing from this list, so the #4217
// icon migration silently skipped four functional status indicators and future
// PRs could reintroduce that class with green CI.
const LEADING_UI_SYMBOL_PATTERN = /^\s*[★☆✓✔✕✖✗⚠ℹ▶◀▲▼→←↑↓●○◐◯⊘]/u;

export function containsHardcodedUiGlyph(value) {
  if (typeof value !== 'string') return false;
  // Copyright, registered, and trademark marks are legal/text notation, not UI icons.
  const normalized = value.replace(/[©®™]/gu, '');
  // Mid-sentence arrows describe direction/relationships; a leading arrow is an icon.
  const emojiCandidate = normalized.replace(/[↔→←↑↓]/gu, '');
  return EMOJI_PATTERN.test(emojiCandidate) || LEADING_UI_SYMBOL_PATTERN.test(normalized);
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
      const insideDiagnosticCall = context.sourceCode.getAncestors(node).some((ancestor) =>
        ancestor.type === 'CallExpression' &&
        ancestor.callee?.type === 'MemberExpression' &&
        ancestor.callee.object?.type === 'Identifier' &&
        ['logger', 'console'].includes(ancestor.callee.object.name));
      if (insideDiagnosticCall) return;
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
      // Evaluate the template as ONE string rather than per-quasi. Visiting
      // TemplateElement individually made the leading-symbol test fire on every
      // chunk boundary: in `Open ${name} → Node Details` the second quasi is
      // " → Node Details", so a genuinely mid-sentence arrow read as leading and
      // was reported — contradicting the mid-sentence-arrow exemption above.
      // Quasis are joined with a space to stand in for the interpolation, which
      // is enough for both the leading test and the emoji scan.
      TemplateLiteral(node) {
        report(node, node.quasis.map((q) => q.value.raw).join(' '));
      },
    };
  },
};
