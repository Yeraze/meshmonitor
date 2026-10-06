/**
 * ESLint rule: no raw `<input type="number">` (#5649).
 *
 * A controlled number input bound straight to number state cannot be cleared:
 * `parseInt(e.target.value) || 60` turns the blank field back into 60 before
 * the user can type the next digit. `NumberInput`
 * (src/components/common/NumberInput.tsx) owns the text while it is edited,
 * marks blank / out-of-range text invalid, and never hands the form a value it
 * should not save. Every number field goes through it.
 */

/** The static string value of a JSX attribute, or null when it is dynamic. */
function staticAttributeValue(attribute) {
  const value = attribute.value;
  if (!value) return null;
  if (value.type === 'Literal') return typeof value.value === 'string' ? value.value : null;
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
    if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) {
      return expr.quasis[0].value.cooked;
    }
  }
  return null;
}

export const noRawNumberInput = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Use NumberInput instead of a raw <input type="number"> (#5649)',
    },
    schema: [],
    messages: {
      rawNumberInput:
        'Use <NumberInput> (src/components/common/NumberInput.tsx) instead of <input type="number">: a raw number input cannot be cleared and can save a blank or out-of-range value (#5649).',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'input') return;
        for (const attribute of node.attributes) {
          if (attribute.type !== 'JSXAttribute') continue;
          if (attribute.name.name !== 'type') continue;
          if (staticAttributeValue(attribute) === 'number') {
            context.report({ node: attribute, messageId: 'rawNumberInput' });
          }
        }
      },
    };
  },
};
