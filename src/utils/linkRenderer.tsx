import React from 'react';

// URL detection regex - matches http://, https://, and www. URLs
const URL_REGEX = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;

/**
 * Renders text with clickable links for any URLs found
 * @param text - The message text to process
 * @returns JSX elements with URLs converted to clickable links
 */
export function renderMessageWithLinks(text: string): React.ReactNode[] {
  if (!text) return [];

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = match[0];
    const matchIndex = match.index;

    // Add text before the URL
    if (matchIndex > lastIndex) {
      parts.push(text.substring(lastIndex, matchIndex));
    }

    // Normalize URL - add https:// if it starts with www.
    let href = url;
    if (url.startsWith('www.')) {
      href = 'https://' + url;
    }

    // Add the clickable link
    parts.push(
      <a
        key={`link-${matchIndex}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="message-link"
        onClick={(e) => e.stopPropagation()} // Prevent message click events
      >
        {url}
      </a>
    );

    lastIndex = matchIndex + url.length;
  }

  // Add remaining text after the last URL
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no URLs were found, return the original text
  return parts.length > 0 ? parts : [text];
}

/**
 * Link metadata interface for previews
 */
export interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/**
 * Extracts URLs from message text
 * @param text - The message text to process
 * @returns Array of URLs found in the text
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];

  URL_REGEX.lastIndex = 0;
  const matches = text.match(URL_REGEX);

  if (!matches) return [];

  // Normalize URLs
  return matches.map(url => {
    if (url.startsWith('www.')) {
      return 'https://' + url;
    }
    return url;
  });
}

/**
 * Fetches link preview metadata for a URL
 * @param url - The URL to fetch metadata for
 * @returns Promise with link metadata or null if fetch fails
 */
export async function fetchLinkPreview(url: string): Promise<LinkMetadata | null> {
  try {
    // Import API service dynamically to avoid circular dependencies
    const apiModule = await import('../services/api');
    const api = apiModule.default;

    const metadata = await api.fetchLinkPreview(url);
    return metadata;
  } catch (error) {
    console.error('Error fetching link preview:', error);
    return null;
  }
}
