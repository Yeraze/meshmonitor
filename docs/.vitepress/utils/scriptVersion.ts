/**
 * Script version helpers for the User Scripts Gallery (#5255).
 *
 * An author declares a version in the script's own `mm_meta` block, in their
 * repo. MeshMonitor's installed-scripts inventory reads the same field
 * (`parseScriptMetadata` in `src/server/routes/scriptRoutes.ts`), so the
 * gallery and an install show the same number without the gallery JSON having
 * to track every release.
 */

/** Longest version string we show; matches the server-side mm_meta limit. */
export const MAX_VERSION_LENGTH = 20;

/**
 * Read `version:` from a script's `mm_meta` comment block.
 *
 * @param code - Full script source
 * @returns The version, or null when the block or field is missing or blank
 */
export function parseMmMetaVersion(code: string): string | null {
  if (!code || typeof code !== 'string') return null;
  // Same block shape the server accepts: `# mm_meta:` or `// mm_meta:` followed
  // by indented `key: value` comment lines.
  const block = code.match(/^[#/]{1,2}\s*mm_meta:\s*\n((?:[#/]{1,2}\s+\w+:.*\n?)+)/m);
  if (!block) return null;
  const field = block[1].match(/^[#/]{1,2}\s+version:\s*(.+)$/m);
  return cleanVersion(field?.[1]);
}

/**
 * Trim a version and drop anything that is not plain text. The gallery renders
 * it with text interpolation, but a version is a short token, so reject
 * markup-like or oversized values rather than display them.
 */
export function cleanVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v(?=\d)/i, '');
  if (!trimmed || trimmed.length > MAX_VERSION_LENGTH) return null;
  if (!/^[\w.+-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The version to show for a gallery entry. The author's `mm_meta` wins because
 * it lives next to the code; the gallery JSON `version` is the fallback for
 * scripts whose code has not loaded or that carry no mm_meta version.
 */
export function resolveScriptVersion(
  entry: { version?: unknown },
  code?: string | null,
): { version: string; source: 'script' | 'gallery' } | null {
  const fromScript = code ? parseMmMetaVersion(code) : null;
  if (fromScript) return { version: fromScript, source: 'script' };
  const fromGallery = cleanVersion(entry.version);
  return fromGallery ? { version: fromGallery, source: 'gallery' } : null;
}
