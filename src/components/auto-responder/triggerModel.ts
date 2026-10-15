/**
 * Meshtastic Auto Responder trigger rules (#5808): validation, the shape a
 * trigger is saved in, and the local matcher the test box uses.
 *
 * The validation and save shape are the ones the old inline Add form and the
 * TriggerItem edit form applied; they moved here when both forms became the
 * one expanded TriggerCard editor.
 */
import type { AutoResponderTrigger, ResponseType } from './types';
import {
  splitTriggerPatterns,
  extractParameters,
  testSinglePattern,
  buildRegexPattern,
  getExampleValueForParam,
} from './utils';
import { normalizeTriggerChannels } from '../../utils/autoResponderUtils';

type TFn = (key: string, options?: Record<string, unknown>) => string;

export interface Validation {
  valid: boolean;
  error?: string;
}

/** Per-field errors for one trigger; empty when the trigger is valid. */
export interface TriggerErrors {
  trigger?: string;
  response?: string;
  channels?: string;
}

/** Text shown in the pattern input: arrays join with ", ". */
export function patternText(trigger: string | string[]): string {
  return Array.isArray(trigger) ? trigger.join(', ') : trigger;
}

export function validateTriggerPattern(trigger: string | string[], t: TFn): Validation {
  if (Array.isArray(trigger)) {
    if (trigger.length === 0) return { valid: false, error: t('auto_responder.trigger_empty') };
    for (const pattern of trigger) {
      if (typeof pattern !== 'string' || !pattern.trim()) continue;
      const v = validateTriggerPattern(pattern, t);
      if (!v.valid) return v;
    }
    return { valid: true };
  }
  if (!trigger || typeof trigger !== 'string' || !trigger.trim()) {
    return { valid: false, error: t('auto_responder.trigger_empty') };
  }
  const patterns = splitTriggerPatterns(trigger);
  if (patterns.length === 0) return { valid: false, error: t('auto_responder.trigger_empty') };
  for (let i = 0; i < patterns.length; i++) {
    if (!patterns[i].trim()) return { valid: false, error: t('auto_responder.pattern_empty', { index: i + 1 }) };
    if (patterns[i].length > 100) return { valid: false, error: t('auto_responder.pattern_too_long', { index: i + 1 }) };
  }
  return { valid: true };
}

export function validateResponse(response: string, type: ResponseType, t: TFn): Validation {
  // Mailbox is a built-in handler that parses the message itself.
  if (type === 'mailbox') return { valid: true };
  if (!response.trim()) return { valid: false, error: t('auto_responder.response_empty') };

  if (type === 'http') {
    try {
      const url = new URL(response.replace(/{[^}]+}/g, 'test'));
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, error: t('auto_responder.url_protocol') };
      }
    } catch {
      return { valid: false, error: t('auto_responder.invalid_url') };
    }
  } else if (type === 'script') {
    if (!response.startsWith('/data/scripts/')) return { valid: false, error: t('auto_responder.script_path_prefix') };
    const ext = response.split('.').pop()?.toLowerCase();
    if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
      return { valid: false, error: t('auto_responder.script_extension') };
    }
    if (response.includes('..')) return { valid: false, error: t('auto_responder.script_path_dotdot') };
  } else if (response.length > 200) {
    return { valid: false, error: t('auto_responder.text_too_long') };
  }
  return { valid: true };
}

/**
 * The channels the editor shows. Once the editor has written `channels` (and
 * cleared the legacy `channel`), an empty list means "none ticked" rather than
 * "fall back to the legacy field".
 */
export function editableChannels(trigger: AutoResponderTrigger): Array<number | 'dm' | 'none'> {
  return Array.isArray(trigger.channels) && trigger.channel === undefined
    ? trigger.channels
    : normalizeTriggerChannels(trigger);
}

export function validateAutoResponderTrigger(trigger: AutoResponderTrigger, t: TFn): TriggerErrors {
  const errors: TriggerErrors = {};
  const p = validateTriggerPattern(trigger.trigger, t);
  if (!p.valid) errors.trigger = p.error || t('auto_responder.invalid_trigger');
  const r = validateResponse(trigger.response ?? '', trigger.responseType, t);
  if (!r.valid) errors.response = r.error || t('auto_responder.invalid_response');
  if (editableChannels(trigger).length === 0) errors.channels = t('auto_responder.no_channels_selected');
  return errors;
}

export const hasErrors = (e: TriggerErrors): boolean => !!(e.trigger || e.response || e.channels);

/**
 * Store a pattern the way the edit form did: several comma-separated patterns
 * become an array, one stays a string. Splits with the brace-aware splitter
 * the server uses, so `{n:\d{2,3}}` is not cut at its comma.
 */
export function normalizePatternText(text: string): string | string[] {
  const patterns = splitTriggerPatterns(text);
  if (patterns.length > 1) return patterns;
  return text.trim();
}

/**
 * The shape an edited or new trigger is saved in. The same rules the old
 * forms applied on Save / Add: trimmed response, multiline only for
 * non-script types, verify only with DM, script args only for scripts, a zero
 * cooldown left out, and the legacy single `channel` dropped.
 */
export function finalizeTrigger(trigger: AutoResponderTrigger): AutoResponderTrigger {
  const rt = trigger.responseType;
  const channels = editableChannels(trigger);
  const scriptArgs = rt === 'script' && trigger.scriptArgs?.trim() ? trigger.scriptArgs.trim() : undefined;
  return {
    ...trigger,
    trigger: normalizePatternText(patternText(trigger.trigger)),
    responseType: rt,
    response: (trigger.response ?? '').trim(),
    multiline: rt !== 'script' ? !!trigger.multiline : undefined,
    verifyResponse: channels.includes('dm') ? !!trigger.verifyResponse : false,
    channels,
    channel: undefined,
    scriptArgs,
    cooldownSeconds: trigger.cooldownSeconds || undefined,
  };
}

/** A blank trigger, with the old Add form's defaults. */
export function newAutoResponderTrigger(): AutoResponderTrigger {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    trigger: '',
    responseType: 'text',
    response: '',
    multiline: false,
    verifyResponse: false,
    channels: ['dm'],
  };
}

export interface TriggerMatch {
  matchedPattern: string;
  params: Record<string, string>;
  regexPattern: string;
}

/** Local match of one message against one trigger; first matching pattern wins. */
export function matchAutoResponderTrigger(trigger: AutoResponderTrigger, message: string): TriggerMatch | null {
  for (const pattern of splitTriggerPatterns(trigger.trigger)) {
    let m: { params?: Record<string, string> } | null;
    try {
      m = testSinglePattern(pattern, message);
    } catch {
      // A parameter regex that does not compile matches nothing.
      m = null;
    }
    if (m) {
      return { matchedPattern: pattern, params: m.params ?? {}, regexPattern: buildRegexPattern(pattern) };
    }
  }
  return null;
}

/** Fill `{param}` placeholders with the extracted values, or example values. */
export function renderSampleResponse(trigger: AutoResponderTrigger, params?: Record<string, string>): string {
  let response = trigger.response ?? '';
  if (params && Object.keys(params).length > 0) {
    for (const [key, value] of Object.entries(params)) {
      response = response.replace(new RegExp(`\\{${key}\\}`, 'g'), value ?? '');
    }
    return response;
  }
  for (const param of extractParameters(patternText(trigger.trigger))) {
    response = response.replace(
      new RegExp(`\\{${param.name}\\}`, 'g'),
      getExampleValueForParam(param.name, param.pattern),
    );
  }
  return response;
}

/** "DM+CH0" style label for a trigger's channels. */
export function channelsLabel(trigger: AutoResponderTrigger): string {
  return normalizeTriggerChannels(trigger)
    .map((c) => (c === 'dm' ? 'DM' : c === 'none' ? 'NONE' : `CH${c}`))
    .join('+');
}
