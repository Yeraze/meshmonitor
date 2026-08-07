/**
 * Issue #4596 — `package.json` has `"type": "module"`, so Node's ESM loader does
 * no extension inference on relative specifiers. A specifier like
 * `'../components/map/markerIcons'` compiles through `tsc` unchanged and then
 * throws `ERR_MODULE_NOT_FOUND` at runtime even when the target file is sitting
 * right next to it on disk.
 *
 * `tsx`/Vite/Vitest all resolve extensionless specifiers, so this class of bug is
 * invisible in dev and in the test suite — it only surfaces in a deployment that
 * runs the compiled `dist/` (Docker, desktop, bare Node).
 *
 * This rule is scoped in eslint.config.mjs to the directories that
 * tsconfig.server.json compiles into `dist/`.
 */

// Anything already carrying an extension is fine. CSS/asset specifiers are
// bundler-only concerns and are handled by the frontend build, not Node.
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.(json|node|css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|yaml|yml|wasm|txt|md)$/i;

export function isExtensionlessRelativeSpecifier(value) {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('./') && !value.startsWith('../')) return false;
  return !HAS_EXTENSION.test(value);
}

export const requireRelativeImportExtension = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an explicit file extension on relative import/export specifiers in server-compiled code (Node ESM has no extension inference).',
    },
    schema: [],
    messages: {
      missingExtension:
        "Relative specifier '{{ specifier }}' has no file extension. This file is compiled into dist/ and loaded by Node's ESM loader, which does not infer extensions — add '.js' (TypeScript maps '.js' back to the '.ts'/'.tsx' source). See issue #4596.",
    },
  },
  create(context) {
    const check = (node) => {
      const source = node?.source;
      if (!source || source.type !== 'Literal') return;
      if (!isExtensionlessRelativeSpecifier(source.value)) return;
      context.report({
        node: source,
        messageId: 'missingExtension',
        data: { specifier: source.value },
      });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      // `await import('./foo')` — same resolution rules apply.
      ImportExpression(node) {
        const arg = node.source;
        if (!arg || arg.type !== 'Literal') return;
        if (!isExtensionlessRelativeSpecifier(arg.value)) return;
        context.report({
          node: arg,
          messageId: 'missingExtension',
          data: { specifier: arg.value },
        });
      },
    };
  },
};
