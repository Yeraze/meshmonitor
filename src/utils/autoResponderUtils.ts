/**
 * Utility functions for auto-responder trigger processing
 */

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
export function splitTriggerPatterns(triggerStr: string): string[] {
  if (!triggerStr.trim()) {
    return [];
  }
  
  const patterns: string[] = [];
  let currentPattern = '';
  let braceDepth = 0;
  
  for (let i = 0; i < triggerStr.length; i++) {
    const char = triggerStr[i];
    
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

