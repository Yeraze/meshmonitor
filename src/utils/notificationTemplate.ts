/**
 * Message-notification title/body templates (#5593).
 *
 * Pure and shared: the server renders a notification with it, the routes
 * validate a saved template with it, and the Notifications tab uses the same
 * functions for its live preview, so the preview cannot drift from a real send.
 *
 * Syntax is the Automation Engine's `{{ token }}` — rendering goes through
 * `interpolate`, there is no second engine here. This module only supplies the
 * token values, the defaults, validation, and output hygiene.
 */
import { interpolate, extractPaths } from '../server/services/automation/interpolate.js';

/** The values a message notification can show. */
export interface MessageTemplateContext {
  /** Name of the source (instance) that heard the message. */
  sourceName: string;
  /** Channel name. Empty for a direct message. */
  channelName: string;
  /** Sender's long name (falls back to short name / node id upstream). */
  senderName: string;
  /** Sender's short name. Falls back to `senderName` when the sender has none. */
  senderShortName: string;
  /** The message text, untruncated. The formatter truncates it. */
  text: string;
  /** "Meshtastic" / "MeshCore" / "MQTT" / "Reticulum" / "Mesh". */
  serviceLabel: string;
  isDM: boolean;
}

/** Token names, in the order the UI lists them. */
export const MESSAGE_TEMPLATE_TOKENS = [
  'sourceName',
  'channelName',
  'senderName',
  'senderShortName',
  'text',
  'serviceLabel',
  'isDM',
] as const;

export type MessageTemplateToken = (typeof MESSAGE_TEMPLATE_TOKENS)[number];

const TOKEN_SET: ReadonlySet<string> = new Set(MESSAGE_TEMPLATE_TOKENS);

/** Longest template a user may save. */
export const MESSAGE_TITLE_TEMPLATE_MAX = 200;
export const MESSAGE_BODY_TEMPLATE_MAX = 500;

/** Longest rendered string handed to a delivery service. */
export const MESSAGE_TITLE_RENDERED_MAX = 150;
export const MESSAGE_BODY_RENDERED_MAX = 400;

/** The `text` token is cut to this length (same limit as before #5593). */
export const MESSAGE_TEXT_MAX = 100;

/** What `{{ isDM }}` renders for a direct message. It renders empty otherwise. */
export const IS_DM_LABEL = 'DM';

/**
 * Built-in templates, used when a user has saved none.
 *
 * The source name appears exactly once, in the title. A channel message leads
 * with the channel; a direct message has no channel, so it leads with the
 * sender and the body is the text alone.
 */
export const DEFAULT_MESSAGE_TEMPLATES = {
  channel: {
    title: '{{ channelName }} · {{ sourceName }}',
    body: '{{ senderName }}: {{ text }}',
  },
  dm: {
    title: '{{ senderName }} · {{ sourceName }}',
    body: '{{ text }}',
  },
} as const;

export interface MessageTemplates {
  /** Null/empty = built-in default. */
  titleTemplate?: string | null;
  /** Null/empty = built-in default. */
  bodyTemplate?: string | null;
}

export interface RenderedMessageNotification {
  title: string;
  body: string;
}

export type TemplateErrorCode =
  | 'TEMPLATE_NOT_STRING'
  | 'TEMPLATE_TOO_LONG'
  | 'TEMPLATE_UNKNOWN_TOKEN'
  | 'TEMPLATE_INVALID_CHARACTERS';

export interface TemplateValidationError {
  code: TemplateErrorCode;
  message: string;
  /** Present for TEMPLATE_UNKNOWN_TOKEN. */
  unknownTokens?: string[];
}

// Marks where a token rendered empty, so a separator left dangling beside it
// can be dropped. Private-use code point: stripped from every input first.
const EMPTY = '';
const SEPARATOR = '[·•|:,\\-–—/]';

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_FOR_VALIDATION = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;

/** Normalise a stored/posted template value: blank means "use the default". */
export function normalizeTemplate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length === 0 ? null : value;
}

/**
 * Validate a template a user wants to save. Returns null when it is fine.
 *
 * Unknown tokens are REJECTED here (the user gets a clear error naming them)
 * rather than saved and silently rendered empty. Angle brackets and control
 * characters are rejected too: the template's literal text reaches push
 * payloads and Apprise calls, and must not carry markup.
 */
export function validateMessageTemplate(
  value: unknown,
  kind: 'title' | 'body',
): TemplateValidationError | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    return { code: 'TEMPLATE_NOT_STRING', message: `The ${kind} template must be text or null` };
  }
  const max = kind === 'title' ? MESSAGE_TITLE_TEMPLATE_MAX : MESSAGE_BODY_TEMPLATE_MAX;
  if (value.length > max) {
    return { code: 'TEMPLATE_TOO_LONG', message: `The ${kind} template is longer than ${max} characters` };
  }
  if (/[<>]/.test(value) || CONTROL_FOR_VALIDATION.test(value) || (kind === 'title' && /[\r\n]/.test(value))) {
    return {
      code: 'TEMPLATE_INVALID_CHARACTERS',
      message:
        kind === 'title'
          ? 'The title template cannot contain <, >, line breaks, or control characters'
          : 'The body template cannot contain <, >, or control characters',
    };
  }
  const unknownTokens = extractPaths(value).filter((p) => !TOKEN_SET.has(p));
  if (unknownTokens.length > 0) {
    return {
      code: 'TEMPLATE_UNKNOWN_TOKEN',
      message: `Unknown token${unknownTokens.length > 1 ? 's' : ''} in the ${kind} template: ${unknownTokens
        .map((p) => `{{ ${p} }}`)
        .join(', ')}`,
      unknownTokens,
    };
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.substring(0, max - 3)}...` : value;
}

/** Token values are data: drop control characters, flatten line breaks. */
function cleanValue(value: string): string {
  return String(value ?? '')
    .replace(CONTROL_EXCEPT_NEWLINE, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/** Defence in depth for a row that did not come through the route validator. */
function cleanTemplate(template: string, kind: 'title' | 'body'): string {
  const cleaned = template.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').replace(/[<>]/g, '');
  return kind === 'title' ? cleaned.replace(/\n+/g, ' ') : cleaned;
}

/**
 * Drop a separator left dangling by an empty token — `{{ channelName }} · X`
 * for a DM reads `X`, not `· X`. Only a separator NEXT TO an empty token is
 * touched; separators inside real values (a message starting "- ") are kept.
 */
function tidyLine(line: string): string {
  let out = line;
  const middle = new RegExp(`(\\s*${SEPARATOR}\\s*)${EMPTY}\\s*${SEPARATOR}\\s*`, 'g');
  const leading = new RegExp(`^(?:\\s*${EMPTY})+\\s*${SEPARATOR}\\s*`);
  const trailing = new RegExp(`\\s*${SEPARATOR}\\s*(?:${EMPTY}\\s*)+$`);
  let previous: string;
  do {
    previous = out;
    out = out.replace(middle, '$1').replace(leading, '').replace(trailing, '');
  } while (out !== previous);
  return out.split(EMPTY).join('').replace(/[ \t]{2,}/g, ' ').trim();
}

function renderOne(
  template: string,
  kind: 'title' | 'body',
  values: Record<MessageTemplateToken, string>,
): string {
  const rendered = interpolate(cleanTemplate(template, kind), (path) => {
    // Unknown tokens render empty. The route rejects them at save, so this
    // only matters for a row written some other way.
    const value = TOKEN_SET.has(path) ? values[path as MessageTemplateToken] : '';
    return value.length > 0 ? value : EMPTY;
  });
  const lines = rendered
    .split('\n')
    .map(tidyLine)
    .filter((line) => line.length > 0);
  const joined = kind === 'title' ? lines.join(' ') : lines.join('\n');
  return truncate(joined, kind === 'title' ? MESSAGE_TITLE_RENDERED_MAX : MESSAGE_BODY_RENDERED_MAX);
}

/**
 * Render a message notification's title and body.
 *
 * One custom template pair serves channel messages and direct messages alike;
 * `{{ channelName }}` is empty for a DM and `{{ isDM }}` is "DM" for one. The
 * built-in default does differ by kind (see DEFAULT_MESSAGE_TEMPLATES).
 *
 * A template that renders to nothing falls back to the default, so a
 * notification is never sent blank.
 */
export function renderMessageNotification(
  context: MessageTemplateContext,
  templates?: MessageTemplates | null,
): RenderedMessageNotification {
  const senderName = cleanValue(context.senderName);
  const values: Record<MessageTemplateToken, string> = {
    sourceName: cleanValue(context.sourceName),
    channelName: context.isDM ? '' : cleanValue(context.channelName),
    senderName,
    senderShortName: cleanValue(context.senderShortName) || senderName,
    text: truncate(cleanValue(context.text), MESSAGE_TEXT_MAX),
    serviceLabel: cleanValue(context.serviceLabel),
    isDM: context.isDM ? IS_DM_LABEL : '',
  };
  const defaults = context.isDM ? DEFAULT_MESSAGE_TEMPLATES.dm : DEFAULT_MESSAGE_TEMPLATES.channel;
  const titleTemplate = normalizeTemplate(templates?.titleTemplate);
  const bodyTemplate = normalizeTemplate(templates?.bodyTemplate);

  let title = titleTemplate ? renderOne(titleTemplate, 'title', values) : '';
  if (title.length === 0) title = renderOne(defaults.title, 'title', values);
  let body = bodyTemplate ? renderOne(bodyTemplate, 'body', values) : '';
  if (body.length === 0) body = renderOne(defaults.body, 'body', values);
  return { title, body };
}
