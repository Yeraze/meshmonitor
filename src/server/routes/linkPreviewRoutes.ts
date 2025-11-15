import express from 'express';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/**
 * Fetches link preview metadata from a URL
 * Extracts Open Graph and meta tags for preview display
 */
router.get('/link-preview', optionalAuth(), async (req, res) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Validate URL format
    let validatedUrl: URL;
    try {
      validatedUrl = new URL(url);

      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
        return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    logger.debug(`📎 Fetching link preview for: ${url}`);

    // Fetch the URL with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'MeshMonitor-LinkPreview/1.0',
        },
        // Only fetch the first 50KB to avoid large downloads
        // @ts-ignore - TypeError is expected for size limit
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(`Failed to fetch URL: ${response.status} ${response.statusText}`);
        return res.status(response.status).json({ error: 'Failed to fetch URL' });
      }

      // Check content type - only process HTML
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        logger.debug(`URL is not HTML (${contentType}), returning basic metadata`);
        return res.json({
          url,
          title: validatedUrl.hostname,
          siteName: validatedUrl.hostname
        } as LinkMetadata);
      }

      // Read response body with size limit
      const html = await response.text();

      // Parse metadata from HTML
      const metadata = extractMetadata(html, url);

      logger.debug(`✅ Link preview extracted: ${metadata.title || 'No title'}`);
      res.json(metadata);

    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        logger.warn(`Link preview fetch timeout for: ${url}`);
        return res.status(504).json({ error: 'Request timeout' });
      }

      logger.error('Error fetching link preview:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch link preview' });
    }

  } catch (error) {
    logger.error('Error in link preview endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Extracts metadata from HTML content
 * Looks for Open Graph tags, Twitter Card tags, and standard meta tags
 */
function extractMetadata(html: string, url: string): LinkMetadata {
  const metadata: LinkMetadata = { url };

  // Extract Open Graph tags
  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const ogDescription = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const ogSiteName = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);

  // Extract Twitter Card tags as fallback
  const twitterTitle = html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
  const twitterDescription = html.match(/<meta[^>]*name=["']twitter:description["'][^>]*content=["']([^"']+)["']/i);
  const twitterImage = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);

  // Extract standard meta tags as fallback
  const metaDescription = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);

  // Populate metadata with preference: OG > Twitter > Standard
  metadata.title = ogTitle?.[1] || twitterTitle?.[1] || titleTag?.[1];
  metadata.description = ogDescription?.[1] || twitterDescription?.[1] || metaDescription?.[1];
  metadata.image = ogImage?.[1] || twitterImage?.[1];
  metadata.siteName = ogSiteName?.[1];

  // Clean up HTML entities in text fields
  if (metadata.title) {
    metadata.title = decodeHtmlEntities(metadata.title);
  }
  if (metadata.description) {
    metadata.description = decodeHtmlEntities(metadata.description);
  }
  if (metadata.siteName) {
    metadata.siteName = decodeHtmlEntities(metadata.siteName);
  }

  // Make image URL absolute if it's relative
  if (metadata.image && !metadata.image.startsWith('http')) {
    try {
      const baseUrl = new URL(url);
      metadata.image = new URL(metadata.image, baseUrl.origin).toString();
    } catch (error) {
      logger.warn('Failed to resolve relative image URL:', error);
      delete metadata.image;
    }
  }

  return metadata;
}

/**
 * Decodes HTML entities in text
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
  };

  return text.replace(/&[a-z0-9#]+;/gi, (match) => entities[match] || match);
}

export default router;
