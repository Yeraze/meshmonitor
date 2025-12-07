import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { extractUrls, fetchLinkPreview, LinkMetadata } from '../utils/linkRenderer';

interface LinkPreviewProps {
  text: string;
}

/**
 * Component that displays link previews for URLs found in message text
 * Fetches metadata from backend and displays rich preview cards
 * Uses Intersection Observer for lazy loading - only fetches when visible
 */
export const LinkPreview: React.FC<LinkPreviewProps> = ({ text }) => {
  const { t } = useTranslation();
  const [previews, setPreviews] = useState<LinkMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const urls = extractUrls(text);

    // Don't set up observer if there are no URLs
    if (urls.length === 0) {
      return;
    }

    // Set up Intersection Observer for lazy loading
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !hasLoaded) {
            console.log('[LinkPreview] Message entered viewport, loading preview');
            loadPreviews();
            setHasLoaded(true);
            // Stop observing once loaded
            if (containerRef.current) {
              observer.unobserve(containerRef.current);
            }
          }
        });
      },
      {
        // Start loading when element is 100px from entering viewport
        rootMargin: '100px',
        threshold: 0.01,
      }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      if (containerRef.current) {
        observer.unobserve(containerRef.current);
      }
    };
  }, [text, hasLoaded]);

  const loadPreviews = async () => {
    const urls = extractUrls(text);

    console.log('[LinkPreview] Extracted URLs from text:', urls);

    if (urls.length === 0) {
      setPreviews([]);
      return;
    }

    setLoading(true);

    try {
      // Fetch preview for the first URL only (to avoid too many previews)
      const url = urls[0];
      console.log('[LinkPreview] Fetching preview for:', url);
      const metadata = await fetchLinkPreview(url);
      console.log('[LinkPreview] Received metadata:', metadata);

      if (metadata) {
        setPreviews([metadata]);
      } else {
        console.warn('[LinkPreview] No metadata returned for URL:', url);
        setPreviews([]);
      }
    } catch (err) {
      console.error('[LinkPreview] Failed to load link preview:', err);
      setPreviews([]);
    } finally {
      setLoading(false);
    }
  };

  // Extract URLs to check if we should render anything
  const urls = extractUrls(text);

  // Don't render anything if there are no URLs
  if (urls.length === 0) {
    return null;
  }

  // Render container with ref for Intersection Observer
  return (
    <div ref={containerRef} className="link-preview-container">
      {loading && (
        <div className="link-preview loading">
          <div className="link-preview-spinner">{t('link_preview.loading')}</div>
        </div>
      )}

      {!loading && previews.length > 0 && previews.map((preview, index) => (
        <a
          key={index}
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="link-preview"
          onClick={(e) => e.stopPropagation()}
        >
          {preview.image && (
            <div className="link-preview-image">
              <img src={preview.image} alt={preview.title || t('link_preview.image_alt')} />
            </div>
          )}
          <div className="link-preview-content">
            {preview.title && (
              <div className="link-preview-title">{preview.title}</div>
            )}
            {preview.description && (
              <div className="link-preview-description">{preview.description}</div>
            )}
            <div className="link-preview-url">
              {preview.siteName || new URL(preview.url).hostname}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
};

export default LinkPreview;
