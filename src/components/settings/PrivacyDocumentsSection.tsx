/**
 * `PrivacyDocumentsSection` — edit the operator's hosted policy documents
 * (#5156).
 *
 * Three documents ('privacy' | 'terms' | 'contact'). For each, the operator
 * can either point at an external URL (a plain setting, edited by the parent
 * Privacy section) or write/upload a document hosted here. A hosted document
 * wins over the URL, so the row says so plainly rather than leaving the
 * operator to discover it.
 *
 * ## Why the file picker reads the file in the browser
 *
 * Upload posts the same JSON as the editor rather than going through a
 * multipart/raw-body route. The payload is Markdown text, `FileReader` gives
 * it to us directly, and one write path means one place where the size cap and
 * the HTML rejection live — the server's PUT handler.
 *
 * Documents are stored and rendered as Markdown with raw HTML disabled; see
 * `PrivacyDocumentPage.tsx`. That is why an `.html` file is refused here
 * rather than silently stored and rendered as escaped tags.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import {
  PRIVACY_DOCUMENT_SLUGS,
  PRIVACY_LINK_FALLBACK_LABEL,
  type PrivacyDocumentAdmin,
  type PrivacyDocumentSlug,
} from '../../types/privacy';
import { seedFromUpload } from './privacyUpload';
import styles from './PrivacyDocumentsSection.module.css';

/** Mirrors the server's cap so the UI can refuse before a round trip. */
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Extensions we accept. Markdown and plain text only — never HTML. */
const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.txt'];

type DocDraft = { title: string; content: string };

export interface PrivacyDocumentsSectionProps {
  /** False for a read-only viewer; hides every mutating control. */
  canEdit: boolean;
}

const PrivacyDocumentsSection: React.FC<PrivacyDocumentsSectionProps> = ({ canEdit }) => {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<Record<string, PrivacyDocumentAdmin>>({});
  const [drafts, setDrafts] = useState<Record<string, DocDraft>>({});
  const [openSlug, setOpenSlug] = useState<PrivacyDocumentSlug | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const reload = useCallback(async () => {
    try {
      const all = await apiService.getPrivacyDocumentsAdmin();
      const bySlug: Record<string, PrivacyDocumentAdmin> = {};
      for (const doc of all) bySlug[doc.slug] = doc;
      setDocs(bySlug);
      setError(null);
    } catch {
      setError(t('privacy.docs.load_failed', 'Failed to load hosted documents.'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const draftFor = (slug: PrivacyDocumentSlug): DocDraft =>
    drafts[slug] ?? {
      title: docs[slug]?.title ?? PRIVACY_LINK_FALLBACK_LABEL[slug],
      content: docs[slug]?.content ?? '',
    };

  const setDraft = (slug: PrivacyDocumentSlug, patch: Partial<DocDraft>) =>
    setDrafts((prev) => ({ ...prev, [slug]: { ...draftFor(slug), ...patch } }));

  const handleSave = async (slug: PrivacyDocumentSlug) => {
    const draft = draftFor(slug);
    if (!draft.title.trim() || !draft.content.trim()) {
      setError(t('privacy.docs.title_and_body_required', 'A title and document body are both required.'));
      return;
    }
    setBusySlug(slug);
    setError(null);
    try {
      await apiService.savePrivacyDocument(slug, draft.title.trim(), draft.content);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('privacy.docs.save_failed', 'Failed to save document.'));
    } finally {
      setBusySlug(null);
    }
  };

  const handleDelete = async (slug: PrivacyDocumentSlug) => {
    setBusySlug(slug);
    setError(null);
    try {
      await apiService.deletePrivacyDocument(slug);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[slug];
        return next;
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('privacy.docs.delete_failed', 'Failed to delete document.'));
    } finally {
      setBusySlug(null);
    }
  };

  const handleFile = async (slug: PrivacyDocumentSlug, file: File) => {
    const lower = file.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setError(
        t(
          'privacy.docs.bad_extension',
          'Documents are stored as Markdown. Upload a .md, .markdown or .txt file.',
        ),
      );
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError(
        t('privacy.docs.too_large', 'That file is larger than {{kb}} KB.', {
          kb: Math.floor(MAX_DOCUMENT_BYTES / 1024),
        }),
      );
      return;
    }
    const text = await file.text();
    const { title, content } = seedFromUpload(text, draftFor(slug).title, slug);
    setDraft(slug, { content, title });
    setOpenSlug(slug);
    setError(null);
  };

  if (!loaded) {
    return <div className="setting-description">{t('common.loading', 'Loading...')}</div>;
  }

  return (
    <div className={styles.section}>
      {error && <div className={styles.error}>{error}</div>}

      {PRIVACY_DOCUMENT_SLUGS.map((slug) => {
        const hosted = docs[slug];
        const draft = draftFor(slug);
        const isOpen = openSlug === slug;
        const busy = busySlug === slug;
        const dirty = drafts[slug] !== undefined;

        return (
          <div key={slug} className={styles.row}>
            <div className={styles.rowHeader}>
              <div>
                <div className={styles.rowTitle}>
                  {t(`privacy.link.${slug}`, PRIVACY_LINK_FALLBACK_LABEL[slug])}
                </div>
                <div className={styles.rowStatus}>
                  {hosted
                    ? t('privacy.docs.hosted_status', 'Hosted here — overrides the URL above.')
                    : t('privacy.docs.not_hosted_status', 'Not hosted. The URL above is used, if set.')}
                </div>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setOpenSlug(isOpen ? null : slug)}
                >
                  {isOpen
                    ? t('common.close', 'Close')
                    : hosted
                      ? t('common.edit', 'Edit')
                      : t('privacy.docs.write', 'Write')}
                </button>
                {canEdit && hosted && (
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => void handleDelete(slug)}
                  >
                    {t('privacy.docs.unpublish', 'Unpublish')}
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className={styles.editor}>
                <label className={styles.label} htmlFor={`privacy-doc-title-${slug}`}>
                  {t('privacy.docs.title_label', 'Title')}
                </label>
                <input
                  id={`privacy-doc-title-${slug}`}
                  type="text"
                  maxLength={255}
                  disabled={!canEdit || busy}
                  value={draft.title}
                  onChange={(e) => setDraft(slug, { title: e.target.value })}
                />

                <label className={styles.label} htmlFor={`privacy-doc-body-${slug}`}>
                  {t('privacy.docs.body_label', 'Document (Markdown)')}
                </label>
                <textarea
                  id={`privacy-doc-body-${slug}`}
                  className={styles.textarea}
                  rows={14}
                  disabled={!canEdit || busy}
                  value={draft.content}
                  placeholder={t(
                    'privacy.docs.body_placeholder',
                    '# Privacy Policy\n\nWhat this instance collects, why, and who to contact.',
                  )}
                  onChange={(e) => setDraft(slug, { content: e.target.value })}
                />
                <p className="setting-description">
                  {t(
                    'privacy.docs.markdown_help',
                    'Markdown only. HTML tags are not rendered — this is what keeps a hosted document from becoming a script on a page your anonymous visitors load.',
                  )}
                </p>

                {canEdit && (
                  <div className={styles.editorActions}>
                    <input
                      ref={(el) => {
                        fileInputs.current[slug] = el;
                      }}
                      type="file"
                      accept={ACCEPTED_EXTENSIONS.join(',')}
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleFile(slug, file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => fileInputs.current[slug]?.click()}
                    >
                      <UiIcon name="upload" size={14} />{' '}
                      {t('privacy.docs.upload', 'Upload file')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy || !dirty}
                      onClick={() => void handleSave(slug)}
                    >
                      {busy ? t('common.saving', 'Saving...') : t('privacy.docs.publish', 'Publish')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PrivacyDocumentsSection;
