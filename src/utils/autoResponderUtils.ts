/**
 * Utility functions for auto-responder trigger processing
 */

import { applyHomoglyphOptimization } from './homoglyph.js';
import { compileUserRegex } from './safeRegex.js';

export interface AutoResponderMatch {
  matched: boolean;
  /** param name -> extracted value (from original text when possible) */
  params: Record<string, string>;
}

/**
 * Match one incoming message against one Meshtastic auto-responder trigger PATTERN
 * (a single comma-split pattern, e.g. "weather {city}" or "zip {z:\\d{5}}").
 * Homoglyph-normalizes both sides, parses the {name}/{name:regex} placeholder DSL,
 * builds an anchored capture regex via compileUserRegex, and extracts params from the
 * ORIGINAL text where possible (Unicode preservation).
 */
export function matchAutoResponderPattern(patternStr: string, messageText: string): AutoResponderMatch {
  // Normalize trigger pattern through homoglyph mapping to match normalized message text
  const normalizedPatternStr = applyHomoglyphOptimization(patternStr);
  // Normalize message text through homoglyph mapping (Issue #2136)
  const normalizedText = applyHomoglyphOptimization(messageText);

  // Extract parameters with optional regex patterns from trigger pattern
  interface ParamSpec {
    name: string;
    pattern?: string;
  }
  const params: ParamSpec[] = [];
  let i = 0;

  while (i < normalizedPatternStr.length) {
    if (normalizedPatternStr[i] === '{') {
      const startPos = i + 1;
      let depth = 1;
      let colonPos = -1;
      let endPos = -1;

      // Find the matching closing brace, accounting for nested braces in regex patterns
      for (let j = startPos; j < normalizedPatternStr.length && depth > 0; j++) {
        if (normalizedPatternStr[j] === '{') {
          depth++;
        } else if (normalizedPatternStr[j] === '}') {
          depth--;
          if (depth === 0) {
            endPos = j;
          }
        } else if (normalizedPatternStr[j] === ':' && depth === 1 && colonPos === -1) {
          colonPos = j;
        }
      }

      if (endPos !== -1) {
        const paramName = colonPos !== -1
          ? normalizedPatternStr.substring(startPos, colonPos)
          : normalizedPatternStr.substring(startPos, endPos);
        const paramPattern = colonPos !== -1
          ? normalizedPatternStr.substring(colonPos + 1, endPos)
          : undefined;

        if (!params.find(p => p.name === paramName)) {
          params.push({ name: paramName, pattern: paramPattern });
        }

        i = endPos + 1;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  // Build regex pattern from trigger by processing it character by character
  let pattern = '';
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  i = 0;

  while (i < normalizedPatternStr.length) {
    if (normalizedPatternStr[i] === '{') {
      const startPos = i;
      let depth = 1;
      let endPos = -1;

      // Find the matching closing brace
      for (let j = i + 1; j < normalizedPatternStr.length && depth > 0; j++) {
        if (normalizedPatternStr[j] === '{') {
          depth++;
        } else if (normalizedPatternStr[j] === '}') {
          depth--;
          if (depth === 0) {
            endPos = j;
          }
        }
      }

      if (endPos !== -1) {
        const paramIndex = replacements.length;
        if (paramIndex < params.length) {
          const paramRegex = params[paramIndex].pattern || '[^\\s]+';
          replacements.push({
            start: startPos,
            end: endPos + 1,
            replacement: `(${paramRegex})`
          });
        }
        i = endPos + 1;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  // Build the final pattern by replacing placeholders
  for (let i = 0; i < normalizedPatternStr.length; i++) {
    const replacement = replacements.find(r => r.start === i);
    if (replacement) {
      pattern += replacement.replacement;
      i = replacement.end - 1; // -1 because loop will increment
    } else {
      // Escape special regex characters in literal parts
      const char = normalizedPatternStr[i];
      if (/[.*+?^${}()|[\]\\]/.test(char)) {
        pattern += '\\' + char;
      } else {
        pattern += char;
      }
    }
  }

  const triggerRegex = compileUserRegex(`^${pattern}$`, 'i');
  const triggerMatch = normalizedText.match(triggerRegex);

  if (triggerMatch) {
    // Extract parameters from original text when possible to preserve full
    // Unicode characters. Homoglyph normalization can mangle Cyrillic words
    // (e.g., "Барнаул" → "Бapнayл") which breaks geocoding APIs.
    // The regex usually matches original text too since param patterns like
    // [^\s]+ accept any non-whitespace character.
    const originalMatch = messageText.match(triggerRegex);

    const extractedParams: Record<string, string> = {};
    params.forEach((param, index) => {
      extractedParams[param.name] = originalMatch?.[index + 1] ?? triggerMatch[index + 1];
    });
    return { matched: true, params: extractedParams };
  }

  return { matched: false, params: {} };
}

/**
 * Splits a comma-separated trigger string into individual patterns.
 * Respects brace-enclosed parameters and doesn't split commas inside them.
 * 
 * @param triggerStr - Comma-separated trigger patterns (e.g., "hello,hi {name}")
 * @returns Array of individual trigger patterns
 * 
 * @example
 * splitTriggerPatterns("hello,hi {name}") // ["hello", "hi {name}"]
 * splitTriggerPatterns("weather {city, state}") // ["weather {city, state}"]
 */
const MAX_TRIGGER_STR_LENGTH = 10000;

export function splitTriggerPatterns(triggerStr: string): string[] {
  if (!triggerStr.trim()) {
    return [];
  }

  // Clamp to a sane upper bound so a user-supplied value can't drive
  // an unbounded loop here.
  const bounded = triggerStr.length > MAX_TRIGGER_STR_LENGTH
    ? triggerStr.slice(0, MAX_TRIGGER_STR_LENGTH)
    : triggerStr;

  const patterns: string[] = [];
  let currentPattern = '';
  let braceDepth = 0;

  for (let i = 0; i < bounded.length; i++) {
    const char = bounded[i];
    
    if (char === '{') {
      braceDepth++;
      currentPattern += char;
    } else if (char === '}') {
      braceDepth--;
      currentPattern += char;
    } else if (char === ',' && braceDepth === 0) {
      // Only split on commas that are outside braces
      const trimmed = currentPattern.trim();
      if (trimmed) {
        patterns.push(trimmed);
      }
      currentPattern = '';
    } else {
      currentPattern += char;
    }
  }
  
  // Add the last pattern
  const trimmed = currentPattern.trim();
  if (trimmed) {
    patterns.push(trimmed);
  }
  
  return patterns;
}

/**
 * Normalizes trigger patterns to an array format.
 * Handles both string (comma-separated) and array formats.
 * 
 * @param trigger - Either a string or array of trigger patterns
 * @returns Array of individual trigger patterns
 * 
 * @example
 * normalizeTriggerPatterns("hello,hi") // ["hello", "hi"]
 * normalizeTriggerPatterns(["hello", "hi"]) // ["hello", "hi"]
 */
export function normalizeTriggerPatterns(trigger: string | string[]): string[] {
  return Array.isArray(trigger) ? trigger : splitTriggerPatterns(trigger);
}



/**
 * Normalizes a trigger's channel field to the new multi-channel array format.
 * Handles backward compatibility with the old single-channel field.
 * 
 * @param trigger - The trigger object (may have old `channel` or new `channels` field)
 * @returns Array of channels this trigger responds to
 * 
 * @example
 * normalizeTriggerChannels({ channels: ['dm', 0] }) // ['dm', 0]
 * normalizeTriggerChannels({ channel: 'dm' }) // ['dm']
 * normalizeTriggerChannels({ channel: 0 }) // [0]
 * normalizeTriggerChannels({}) // ['dm']
 */
export function normalizeTriggerChannels(trigger: { channels?: Array<number | 'dm' | 'none'>; channel?: number | 'dm' | 'none' }): Array<number | 'dm' | 'none'> {
  if (trigger.channels && trigger.channels.length > 0) {
    return trigger.channels;
  }
  if (trigger.channel !== undefined) {
    return [trigger.channel];
  }
  return ['dm'];
}
