/**
 * Gets file icon based on extension
 */
export const getFileIcon = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return '🐍';
    case 'js': case 'mjs': return '📘';
    case 'sh': return '💻';
    default: return '📄';
  }
};

/**
 * Splits a multi-pattern trigger string into individual patterns.
 * Handles comma-separated patterns, but doesn't split commas inside braces.
 * Example: "weather, weather {location}, w {location}" -> ["weather", "weather {location}", "w {location}"]
 */
export const splitTriggerPatterns = (trigger: string | string[]): string[] => {
  // Handle array format (already split)
  if (Array.isArray(trigger)) {
    return trigger.filter(p => p && typeof p === 'string' && p.trim().length > 0);
  }
  
  // Handle string format
  if (!trigger || typeof trigger !== 'string' || !trigger.trim()) {
    return [];
  }
  
  const patterns: string[] = [];
  let currentPattern = '';
  let braceDepth = 0;
  
  for (let i = 0; i < trigger.length; i++) {
    const char = trigger[i];
    
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
  
  const trimmed = currentPattern.trim();
  if (trimmed) {
    patterns.push(trimmed);
  }
  
  return patterns;
};

/**
 * Formats trigger patterns for display, adding spaces after commas for readability.
 * Example: "weather,weather {location}" -> "weather, weather {location}"
 * Handles both string and string[] formats
 */
export const formatTriggerPatterns = (triggerStr: string | string[]): string => {
  // Handle array format
  if (Array.isArray(triggerStr)) {
    return triggerStr.filter(p => p && typeof p === 'string').join(', ');
  }
  
  // Handle string format
  if (!triggerStr || typeof triggerStr !== 'string') {
    return '';
  }
  
  const patterns = splitTriggerPatterns(triggerStr);
  return patterns.join(', ');
};

/**
 * Extracts parameters from a trigger pattern.
 * Returns array of parameter objects with name and optional regex pattern.
 */
export const extractParameters = (trigger: string): Array<{ name: string; pattern?: string }> => {
  const params: Array<{ name: string; pattern?: string }> = [];
  let i = 0;

  while (i < trigger.length) {
    if (trigger[i] === '{') {
      const startPos = i + 1;
      let depth = 1;
      let colonPos = -1;
      let endPos = -1;

      // Find the matching closing brace, accounting for nested braces in regex patterns
      for (let j = startPos; j < trigger.length && depth > 0; j++) {
        if (trigger[j] === '{') {
          depth++;
        } else if (trigger[j] === '}') {
          depth--;
          if (depth === 0) {
            endPos = j;
          }
        } else if (trigger[j] === ':' && depth === 1 && colonPos === -1) {
          colonPos = j;
        }
      }

      if (endPos !== -1) {
        const paramName = colonPos !== -1
          ? trigger.substring(startPos, colonPos)
          : trigger.substring(startPos, endPos);
        const paramPattern = colonPos !== -1
          ? trigger.substring(colonPos + 1, endPos)
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

  return params;
};

/**
 * Builds the regex pattern string for a given trigger pattern (for display/debugging).
 */
export const buildRegexPattern = (pattern: string): string => {
  const params = extractParameters(pattern);
  let regexPattern = '';
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '{') {
      const startPos = i;
      let depth = 1;
      let endPos = -1;

      for (let j = i + 1; j < pattern.length && depth > 0; j++) {
        if (pattern[j] === '{') {
          depth++;
        } else if (pattern[j] === '}') {
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

  for (let i = 0; i < pattern.length; i++) {
    const replacement = replacements.find(r => r.start === i);
    if (replacement) {
      regexPattern += replacement.replacement;
      i = replacement.end - 1;
    } else {
      const char = pattern[i];
      if (/[.*+?^${}()|[\]\\]/.test(char)) {
        regexPattern += '\\' + char;
      } else {
        regexPattern += char;
      }
    }
  }

  return `^${regexPattern}$`;
};

/**
 * Tests if a message matches a single trigger pattern.
 * Returns match info if successful, null otherwise.
 */
export const testSinglePattern = (
  pattern: string,
  message: string
): { params?: Record<string, string> } | null => {
  // Extract parameters with optional regex patterns
  const params = extractParameters(pattern);

  // Build regex pattern from trigger by processing it character by character
  let regexPattern = '';
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '{') {
      const startPos = i;
      let depth = 1;
      let endPos = -1;

      // Find the matching closing brace
      for (let j = i + 1; j < pattern.length && depth > 0; j++) {
        if (pattern[j] === '{') {
          depth++;
        } else if (pattern[j] === '}') {
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
  for (let i = 0; i < pattern.length; i++) {
    const replacement = replacements.find(r => r.start === i);
    if (replacement) {
      regexPattern += replacement.replacement;
      i = replacement.end - 1; // -1 because loop will increment
    } else {
      // Escape special regex characters in literal parts
      const char = pattern[i];
      if (/[.*+?^${}()|[\]\\]/.test(char)) {
        regexPattern += '\\' + char;
      } else {
        regexPattern += char;
      }
    }
  }

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  const match = message.match(regex);

  if (match) {
    const extractedParams: Record<string, string> = {};
    params.forEach((param, index) => {
      extractedParams[param.name] = match[index + 1];
    });
    return { params: extractedParams };
  }
  return null;
};

/**
 * Gets the positions of matched parts in the message (for highlighting).
 */
export const getMatchPositions = (pattern: string, message: string, _params: Record<string, string>): Array<{ start: number; end: number; type: 'literal' | 'parameter' }> => {
  const positions: Array<{ start: number; end: number; type: 'literal' | 'parameter' }> = [];
  const paramsList = extractParameters(pattern);
  
  // Build regex to find matches
  const regexPattern = buildRegexPattern(pattern);
  const regex = new RegExp(regexPattern, 'i');
  const match = message.match(regex);
  
  if (!match) return positions;
  
  // Find literal parts and parameter positions
  let messageIndex = 0;
  let paramIndex = 0;
  let patternIndex = 0;
  
  while (patternIndex < pattern.length && messageIndex < message.length) {
    if (pattern[patternIndex] === '{') {
      // Find the closing brace
      let depth = 1;
      let endPos = patternIndex + 1;
      while (endPos < pattern.length && depth > 0) {
        if (pattern[endPos] === '{') depth++;
        if (pattern[endPos] === '}') depth--;
        if (depth > 0) endPos++;
      }
      
      // This is a parameter
      if (paramIndex < paramsList.length && match[paramIndex + 1]) {
        const paramValue = match[paramIndex + 1];
        const start = messageIndex;
        const end = messageIndex + paramValue.length;
        positions.push({ start, end, type: 'parameter' });
        messageIndex = end;
        paramIndex++;
      }
      patternIndex = endPos + 1;
    } else {
      // This is a literal character
      const char = pattern[patternIndex];
      if (message[messageIndex]?.toLowerCase() === char.toLowerCase()) {
        const start = messageIndex;
        let end = messageIndex + 1;
        // Find consecutive matching literal characters
        while (patternIndex + 1 < pattern.length && 
               pattern[patternIndex + 1] !== '{' &&
               message[end]?.toLowerCase() === pattern[patternIndex + 1]?.toLowerCase()) {
          end++;
          patternIndex++;
        }
        if (end > start) {
          positions.push({ start, end, type: 'literal' });
          messageIndex = end;
        }
      }
      patternIndex++;
    }
  }
  
  return positions;
};

/**
 * Gets an example value for a parameter based on its name and pattern.
 */
export const getExampleValueForParam = (paramName: string, pattern?: string): string => {
  if (pattern) {
    // Try to generate example from regex pattern
    if (pattern.includes('\\d')) {
      if (pattern.includes('{5}')) return '12345';
      if (pattern.includes('{4}')) return '2024';
      return '42';
    }
    if (pattern.includes('[a-zA-Z]')) return 'ABC';
    if (pattern.includes('\\w')) return 'example';
  }
  
  // Default examples based on common parameter names
  const lowerName = paramName.toLowerCase();
  if (lowerName.includes('zip') || lowerName.includes('postal')) return '33076';
  if (lowerName.includes('temp') || lowerName.includes('temperature')) return '72';
  if (lowerName.includes('city') || lowerName.includes('location')) return 'Miami';
  if (lowerName.includes('state')) return 'FL';
  if (lowerName.includes('id') || lowerName.includes('node')) return '!a1b2c3d4';
  if (lowerName.includes('name')) return 'John';
  if (lowerName.includes('message') || lowerName.includes('text') || lowerName.includes('msg')) return 'Hello World';
  
  return 'example';
};

