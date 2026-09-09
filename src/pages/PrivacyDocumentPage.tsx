/**
 * `PrivacyDocumentPage` — renders one operator-hosted policy document (#5156).
 *
 * A standalone route (`/privacy/:slug`) with no auth providers, deliberately:
 * the point of a privacy policy on a publicly-reachable instance is that a
 * logged-out visitor can read it. It is also the link target the tokenless
 * embed bundle sends people to, which is why it must not need a session.
 *
 * ## Safety
 *
 * `content` is Markdown source written by the operator and served to anonymous
 * readers. It is rendered by `react-markdown` with NO `rehype-raw` plugin, so
 * raw HTML in the source is escaped rather than executed. Do not add
 * `rehype-raw` here, and do not switch to `dangerouslySetInnerHTML` — that is
 * the whole reason the column stores Markdown and the write path rejects HTML
 * documents. Links are forced through a renderer that adds
 * `rel="noopener noreferrer"`.
 *
 * `remark-gfm` IS safe to use and is loaded: it extends the Markdown grammar
 * with tables, strikethrough, task lists and autolinks — a retention table is
 * the first thing an operator reaches for in a privacy policy. It does not
 * enable raw HTML; that is `rehype-raw`, which is the one to keep out.
 */
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import apiService from '../services/api';
import { isPrivacyDocumentSlug, type PrivacyDocumentPayload } from '../types/privacy';
import { stripDuplicateHeading } from '../utils/privacyDocumentBody';
import styles from './PrivacyDocumentPage.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PrivacyDocumentPayload }
  | { status: 'missing' }
  | { status: 'error' };

const PrivacyDocumentPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!isPrivacyDocumentSlug(slug)) {
      setState({ status: 'missing' });
      return;
    }
    let cancelled = false;
    apiService
      .getPrivacyDocument(slug)
      .then((doc) => {
        if (!cancelled) setState({ status: 'ready', doc });
      })
      .catch(() => {
        // A 404 (never published) and a 500 read the same to a visitor: there
        // is no document here. Distinguishing them would only leak whether the
        // operator has one configured.
        if (!cancelled) setState({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (state.status === 'ready') {
      document.title = `${state.doc.title} — MeshMonitor`;
    }
  }, [state]);

  if (state.status === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.sheet}>{t('common.loading', 'Loading...')}</div>
      </div>
    );
  }

  if (state.status !== 'ready') {
    return (
      <div className={styles.page}>
        <div className={styles.sheet}>
          <h1 className={styles.title}>{t('privacy.not_found_title', 'Document not found')}</h1>
          <p className={styles.muted}>
            {t(
              'privacy.not_found_body',
              'This MeshMonitor instance has not published that document.',
            )}
          </p>
        </div>
      </div>
    );
  }

  const { doc } = state;
  const updated = new Date(doc.updatedAt);

  return (
    <div className={styles.page}>
      <article className={styles.sheet}>
        <h1 className={styles.title}>{doc.title}</h1>
        <p className={styles.muted}>
          {t('privacy.last_updated', 'Last updated')}{' '}
          <time dateTime={updated.toISOString()}>
            {updated.toLocaleDateString(i18n.language || undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
        </p>
        <div className={styles.body}>
          {/* No rehype-raw: raw HTML in the source is escaped, not executed. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, ...props }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                  {children}
                </a>
              ),
            }}
          >
            {stripDuplicateHeading(doc.content, doc.title)}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
};

export default PrivacyDocumentPage;
