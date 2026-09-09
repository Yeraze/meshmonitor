/**
 * Upload seeding for operator-hosted privacy documents (#5156).
 *
 * Lives in its own module rather than beside the component: exporting a
 * non-component from a `.tsx` component file breaks React Fast Refresh
 * (`react-refresh/only-export-components`).
 */
import {
  PRIVACY_LINK_FALLBACK_LABEL,
  type PrivacyDocumentSlug,
} from '../../types/privacy';

/**
 * Derive the title and body for an uploaded document.
 *
 * An exported policy almost always opens with its own `# Heading`, and the
 * page already renders the stored title as the page's `<h1>`. Seeding the
 * title from that heading and leaving it in the body renders it twice, so
 * when the heading IS consumed as the title it is dropped from the content.
 * The operator sees the result in the textarea before publishing.
 *
 * An operator who has already typed a title keeps it, and the body is left
 * exactly as uploaded — we only remove a heading we actually used.
 */
export function seedFromUpload(
  text: string,
  existingTitle: string,
  slug: PrivacyDocumentSlug,
): { title: string; content: string } {
  if (existingTitle.trim()) {
    return { title: existingTitle.trim(), content: text };
  }
  const match = /^\s*#\s+(.+?)\s*$/m.exec(text);
  const heading = match?.[1]?.trim();
  if (!heading) {
    return { title: PRIVACY_LINK_FALLBACK_LABEL[slug], content: text };
  }
  const content = text.slice(0, match!.index) + text.slice(match!.index + match![0].length);
  return { title: heading, content: content.replace(/^\n+/, '') };
}
