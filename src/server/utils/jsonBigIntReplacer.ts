/**
 * Global JSON.stringify BigInt patch.
 *
 * BigInt values (e.g. node numbers / packet ids surfaced as BigInt on
 * PostgreSQL/MySQL) throw "Do not know how to serialize a BigInt" from the
 * default `JSON.stringify`. This module patches `JSON.stringify` globally to
 * stringify BigInts instead, as a **module-load side effect** — importing it
 * (even without using any export) is what installs the patch. server.ts
 * imports it once, near the top, before anything else can call
 * `JSON.stringify` on a value that might contain a BigInt.
 *
 * Extracted verbatim from server.ts as part of #3502 PR3 composition-root
 * teardown (was the top-of-file `jsonReplacer` + `JSON.stringify` override).
 */

const jsonReplacer = (_key: string, value: any) => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
};

const originalStringify = JSON.stringify;
JSON.stringify = function (value, replacer?: any, space?: any) {
  if (replacer) {
    return originalStringify(value, replacer, space);
  }
  return originalStringify(value, jsonReplacer, space);
};
