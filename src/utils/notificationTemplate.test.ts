/**
 * Message-notification templates (#5593) — pure formatter and validator.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_BODY_RENDERED_MAX,
  MESSAGE_BODY_TEMPLATE_MAX,
  MESSAGE_TEMPLATE_TOKENS,
  MESSAGE_TITLE_RENDERED_MAX,
  MESSAGE_TITLE_TEMPLATE_MAX,
  normalizeTemplate,
  renderMessageNotification,
  validateMessageTemplate,
  type MessageTemplateContext,
} from './notificationTemplate';

const SOURCE = 'M-BAR-EIKSMARKA-WAMB (NF1)';

const channel = (over: Partial<MessageTemplateContext> = {}): MessageTemplateContext => ({
  sourceName: SOURCE,
  channelName: 'NarrowFast',
  senderName: 'OSL-CLIENT-ERKO-TECHO',
  senderShortName: 'ERKO',
  text: 'Og jeg ser ikke Not2 med denne',
  serviceLabel: 'Meshtastic',
  isDM: false,
  ...over,
});

const dm = (over: Partial<MessageTemplateContext> = {}): MessageTemplateContext =>
  channel({ channelName: '', isDM: true, ...over });

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('renderMessageNotification — default', () => {
  it('channel message: channel · source in the title, sender: text in the body', () => {
    expect(renderMessageNotification(channel())).toEqual({
      title: `NarrowFast · ${SOURCE}`,
      body: 'OSL-CLIENT-ERKO-TECHO: Og jeg ser ikke Not2 med denne',
    });
  });

  it('direct message: sender · source in the title, the text alone in the body', () => {
    expect(renderMessageNotification(dm())).toEqual({
      title: `OSL-CLIENT-ERKO-TECHO · ${SOURCE}`,
      body: 'Og jeg ser ikke Not2 med denne',
    });
  });

  it('shows the source name exactly once, for a channel message and for a DM', () => {
    for (const ctx of [channel(), dm()]) {
      const r = renderMessageNotification(ctx);
      expect(occurrences(`${r.title}\n${r.body}`, SOURCE)).toBe(1);
    }
  });

  it('null, undefined and blank templates all mean the default', () => {
    const expected = renderMessageNotification(channel());
    expect(renderMessageNotification(channel(), null)).toEqual(expected);
    expect(renderMessageNotification(channel(), {})).toEqual(expected);
    expect(renderMessageNotification(channel(), { titleTemplate: null, bodyTemplate: null })).toEqual(expected);
    expect(renderMessageNotification(channel(), { titleTemplate: '   ', bodyTemplate: '' })).toEqual(expected);
  });

  it('the default templates use only known tokens and pass validation', () => {
    for (const pair of [DEFAULT_MESSAGE_TEMPLATES.channel, DEFAULT_MESSAGE_TEMPLATES.dm]) {
      expect(validateMessageTemplate(pair.title, 'title')).toBeNull();
      expect(validateMessageTemplate(pair.body, 'body')).toBeNull();
    }
  });
});

describe('renderMessageNotification — custom templates', () => {
  it('renders every token', () => {
    const r = renderMessageNotification(channel(), {
      titleTemplate: '{{ serviceLabel }} / {{ sourceName }} / {{ channelName }}',
      bodyTemplate: '{{senderShortName}} ({{ senderName }}): {{ text }} {{ isDM }}',
    });
    expect(r.title).toBe(`Meshtastic / ${SOURCE} / NarrowFast`);
    expect(r.body).toBe('ERKO (OSL-CLIENT-ERKO-TECHO): Og jeg ser ikke Not2 med denne');
  });

  it('the issue example: short title, short-name body', () => {
    const r = renderMessageNotification(channel(), {
      titleTemplate: '{{ channelName }}: New message',
      bodyTemplate: '{{ senderShortName }}: {{ text }}',
    });
    expect(r).toEqual({ title: 'NarrowFast: New message', body: 'ERKO: Og jeg ser ikke Not2 med denne' });
  });

  it('a custom title with a default body (and the reverse) mix freely', () => {
    const titleOnly = renderMessageNotification(channel(), { titleTemplate: 'Mesh', bodyTemplate: null });
    expect(titleOnly).toEqual({ title: 'Mesh', body: 'OSL-CLIENT-ERKO-TECHO: Og jeg ser ikke Not2 med denne' });
    const bodyOnly = renderMessageNotification(channel(), { titleTemplate: null, bodyTemplate: '{{ text }}' });
    expect(bodyOnly).toEqual({ title: `NarrowFast · ${SOURCE}`, body: 'Og jeg ser ikke Not2 med denne' });
  });

  it('one template pair serves a DM: channelName is empty and its separator is dropped', () => {
    const templates = {
      titleTemplate: '{{ channelName }} · {{ sourceName }}',
      bodyTemplate: '{{ isDM }} {{ senderName }}: {{ text }}',
    };
    expect(renderMessageNotification(dm(), templates)).toEqual({
      title: SOURCE,
      body: 'DM OSL-CLIENT-ERKO-TECHO: Og jeg ser ikke Not2 med denne',
    });
    // The same pair for a channel message: channel shown, isDM empty.
    expect(renderMessageNotification(channel(), templates)).toEqual({
      title: `NarrowFast · ${SOURCE}`,
      body: 'OSL-CLIENT-ERKO-TECHO: Og jeg ser ikke Not2 med denne',
    });
  });

  it('drops a trailing and a middle separator left by an empty token', () => {
    expect(
      renderMessageNotification(dm(), { titleTemplate: '{{ sourceName }} | {{ channelName }}' }).title,
    ).toBe(SOURCE);
    expect(
      renderMessageNotification(dm(), { titleTemplate: '{{ senderShortName }} · {{ channelName }} · {{ sourceName }}' }).title,
    ).toBe(`ERKO · ${SOURCE}`);
  });

  it('keeps separator characters that belong to a real value', () => {
    const r = renderMessageNotification(channel({ text: '- 5 degrees :' }), { bodyTemplate: '{{ text }}' });
    expect(r.body).toBe('- 5 degrees :');
  });

  it('keeps a multi-line body and drops a line that rendered empty', () => {
    const r = renderMessageNotification(dm(), { bodyTemplate: '{{ channelName }}\n{{ senderName }}\n{{ text }}' });
    expect(r.body).toBe('OSL-CLIENT-ERKO-TECHO\nOg jeg ser ikke Not2 med denne');
  });

  it('senderShortName falls back to the sender name when there is no short name', () => {
    const r = renderMessageNotification(channel({ senderShortName: '' }), { bodyTemplate: '{{ senderShortName }}' });
    expect(r.body).toBe('OSL-CLIENT-ERKO-TECHO');
  });
});

describe('renderMessageNotification — missing and unknown tokens', () => {
  it('an unknown token renders empty (never throws)', () => {
    const r = renderMessageNotification(channel(), {
      titleTemplate: 'A {{ nope }} B',
      bodyTemplate: '{{ trigger.text }}{{ text }}',
    });
    expect(r.title).toBe('A B');
    expect(r.body).toBe('Og jeg ser ikke Not2 med denne');
  });

  it('a template that renders to nothing falls back to the default — never a blank notification', () => {
    const r = renderMessageNotification(dm(), { titleTemplate: '{{ channelName }}', bodyTemplate: '{{ nope }}' });
    expect(r).toEqual(renderMessageNotification(dm()));
  });

  it('an empty value leaves no hole in the default', () => {
    const r = renderMessageNotification(channel({ channelName: '' }));
    expect(r.title).toBe(SOURCE);
  });
});

describe('renderMessageNotification — length caps and hygiene', () => {
  it('cuts the text token to 100 characters, as before', () => {
    const r = renderMessageNotification(channel({ text: 'x'.repeat(250) }), { bodyTemplate: '{{ text }}' });
    expect(r.body).toBe(`${'x'.repeat(97)}...`);
  });

  it('caps the rendered title and body', () => {
    const long = 'n'.repeat(300);
    const r = renderMessageNotification(channel({ sourceName: long, senderName: long }), {
      titleTemplate: '{{ sourceName }} {{ sourceName }}',
      bodyTemplate: '{{ senderName }} {{ senderName }} {{ senderName }}',
    });
    expect(r.title).toHaveLength(MESSAGE_TITLE_RENDERED_MAX);
    expect(r.title.endsWith('...')).toBe(true);
    expect(r.body).toHaveLength(MESSAGE_BODY_RENDERED_MAX);
    expect(r.body.endsWith('...')).toBe(true);
  });

  it('does not re-expand a token that arrives inside a value', () => {
    const r = renderMessageNotification(channel({ text: '{{ sourceName }}' }), { bodyTemplate: '{{ text }}' });
    expect(r.body).toBe('{{ sourceName }}');
  });

  it('strips markup and control characters from the template text at render', () => {
    const r = renderMessageNotification(channel(), {
      titleTemplate: '<b>{{ channelName }}</b>\u0007\nline2',
      bodyTemplate: '<img src=x>{{ text }}\u0000',
    });
    expect(r.title).toBe('bNarrowFast/b line2');
    expect(r.title).not.toMatch(/[<>\n\u0007]/);
    expect(r.body).toBe('img src=xOg jeg ser ikke Not2 med denne');
  });

  it('flattens line breaks and control characters inside values', () => {
    const r = renderMessageNotification(channel({ text: 'one\r\ntwo\u0007', senderName: 'A\nB' }));
    expect(r.body).toBe('A B: one two');
  });
});

describe('validateMessageTemplate', () => {
  it('accepts null, undefined, blank, and every documented token', () => {
    expect(validateMessageTemplate(null, 'title')).toBeNull();
    expect(validateMessageTemplate(undefined, 'body')).toBeNull();
    expect(validateMessageTemplate('', 'title')).toBeNull();
    const all = MESSAGE_TEMPLATE_TOKENS.map((t) => `{{ ${t} }}`).join(' ');
    expect(validateMessageTemplate(all, 'title')).toBeNull();
    expect(validateMessageTemplate(`${all}\nsecond line`, 'body')).toBeNull();
  });

  it('rejects an unknown token and names it', () => {
    const err = validateMessageTemplate('{{ senderName }} {{ source_name }} {{ trigger.text }}', 'body');
    expect(err?.code).toBe('TEMPLATE_UNKNOWN_TOKEN');
    expect(err?.unknownTokens).toEqual(['source_name', 'trigger.text']);
    expect(err?.message).toContain('{{ source_name }}');
  });

  it('rejects a template over the length cap, and accepts one at the cap', () => {
    expect(validateMessageTemplate('a'.repeat(MESSAGE_TITLE_TEMPLATE_MAX), 'title')).toBeNull();
    expect(validateMessageTemplate('a'.repeat(MESSAGE_TITLE_TEMPLATE_MAX + 1), 'title')?.code).toBe('TEMPLATE_TOO_LONG');
    expect(validateMessageTemplate('a'.repeat(MESSAGE_BODY_TEMPLATE_MAX), 'body')).toBeNull();
    expect(validateMessageTemplate('a'.repeat(MESSAGE_BODY_TEMPLATE_MAX + 1), 'body')?.code).toBe('TEMPLATE_TOO_LONG');
  });

  it('rejects markup, control characters, and a line break in the title', () => {
    expect(validateMessageTemplate('<b>{{ text }}</b>', 'body')?.code).toBe('TEMPLATE_INVALID_CHARACTERS');
    expect(validateMessageTemplate('a\u0000b', 'body')?.code).toBe('TEMPLATE_INVALID_CHARACTERS');
    expect(validateMessageTemplate('a\nb', 'title')?.code).toBe('TEMPLATE_INVALID_CHARACTERS');
    expect(validateMessageTemplate('a\nb', 'body')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(validateMessageTemplate(42, 'title')?.code).toBe('TEMPLATE_NOT_STRING');
    expect(validateMessageTemplate(['x'], 'body')?.code).toBe('TEMPLATE_NOT_STRING');
  });
});

describe('normalizeTemplate', () => {
  it('maps blank and non-strings to null and keeps real text', () => {
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate(undefined)).toBeNull();
    expect(normalizeTemplate('  \n ')).toBeNull();
    expect(normalizeTemplate('{{ text }}')).toBe('{{ text }}');
  });
});
