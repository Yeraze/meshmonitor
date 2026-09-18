import React from 'react';
import api from '../services/api.js';
import { mentionTokenRegex } from './mentions.js';

// URL detection regex - matches http://, https://, and www. URLs
const URL_REGEX = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;

/**
 * How to render `@!<id>` mention tokens (#5276). Without this, a mention stays
 * readable as its raw token, which is what the acceptance criteria ask for when
 * a node is unknown.
 */
export interface MentionRenderOptions {
  /** Current display name for a node id, or undefined when it is unknown. */
  resolveNodeName?: (nodeId: string) => string | undefined;
  /**
   * Opens the node's details. Without it, the chip is not clickable.
   *
   * The event is passed through because the app's node popup positions itself
   * from `event.currentTarget` — a synthetic stand-in leaves it with nothing to
   * measure and the click silently does nothing.
   */
  onMentionClick?: (nodeId: string, event: React.MouseEvent | React.KeyboardEvent) => void;
  /** The local node's id, so a mention of you stands out further. */
  selfNodeId?: string | null;
}

/**
 * Split a plain-text run into mention chips and text (#5276).
 *
 * The name is resolved at render time rather than stored, so a node that gets
 * renamed shows its new name in old messages — the token on the wire carries
 * the id precisely so this works.
 */
function renderMentions(
  text: string,
  keyPrefix: string,
  options?: MentionRenderOptions
): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(mentionTokenRegex())) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(text.substring(lastIndex, match.index));

    const nodeId = match[1].toLowerCase();
    const name = options?.resolveNodeName?.(nodeId);
    const isSelf = !!options?.selfNodeId && options.selfNodeId.toLowerCase() === nodeId;
    const clickable = !!options?.onMentionClick;

    parts.push(
      <span
        key={`${keyPrefix}-mention-${match.index}`}
        className={`message-mention${isSelf ? ' message-mention-self' : ''}`}
        title={name ? `${name} (${nodeId})` : nodeId}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? (e => { e.stopPropagation(); options!.onMentionClick!(nodeId, e); }) : undefined}
        onKeyDown={clickable
          ? (e => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              options!.onMentionClick!(nodeId, e);
            })
          : undefined}
      >
        @{name || nodeId}
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) parts.push(text.substring(lastIndex));
  return parts;
}

/**
 * Renders text with clickable links for any URLs found, and `@` mentions as
 * chips when mention options are supplied (#5276).
 * @param text - The message text to process
 * @param mentions - Optional mention rendering behaviour
 * @returns JSX elements with URLs converted to clickable links
 */
export function renderMessageWithLinks(
  text: string,
  mentions?: MentionRenderOptions
): React.ReactNode[] {
  if (!text) return [];

  // Replace bell character (0x07) with visible indicator
  text = text.replace(/\x07/g, '(Alert Bell) \u{1F514} ');

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
      parts.push(...renderMentions(text.substring(lastIndex, matchIndex), `pre-${matchIndex}`, mentions));
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
    parts.push(...renderMentions(text.substring(lastIndex), `tail-${lastIndex}`, mentions));
  }

  // If no URLs were found, the mention pass above still produced the parts.
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
    // `api` is imported statically. A previous `await import('../services/api')`
    // here pulled the api module into a lazy chunk whose Vite preload URL was
    // computed without the runtime BASE_URL prefix (e.g. `/assets/…` instead of
    // `/meshmonitor/assets/…`), 404ing and throwing "Unable to preload CSS" on
    // any page where that chunk wasn't already loaded — which silently killed
    // link previews on the MeshCore views. api.ts does not import this module,
    // so there is no circular dependency to avoid.
    const metadata = await api.fetchLinkPreview(url);
    return metadata;
  } catch (error) {
    console.error('Error fetching link preview:', error);
    return null;
  }
}
