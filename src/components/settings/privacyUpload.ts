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
 * An exported policy almost always opens with its own `# Heading`, so that
 * heading is the best guess at a title when the operator has not typed one.
 *
 * The body is left EXACTLY as uploaded. The duplicate-title problem it creates
 * (the page renders the stored title as its own `<h1>`) is solved at render
 * time by `stripDuplicateHeading`, not by rewriting what the operator saved —
 * silently editing their file on the way in is the more surprising behaviour,
 * and it would not help the hand-typed or API-created cases anyway.
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
  return { title: heading, content: text };
}
