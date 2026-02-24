/**
 * Unit Tests for Theme Validation Utilities
 *
 * Comprehensive test suite covering:
 * - Hex color format validation (3, 6, and 8-digit formats)
 * - Theme slug validation (custom- prefix requirement)
 * - Theme name validation
 * - Complete theme definition validation (all 26 required colors)
 * - Theme slug generation
 * - Color normalization
 */

import { describe, it, expect } from 'vitest';
import {
  isValidHexColor,
  isValidThemeSlug,
  isValidThemeName,
  generateThemeSlug,
  validateThemeDefinition,
  isThemeDefinition,
  normalizeHexColor,
  normalizeThemeDefinition,
  REQUIRED_THEME_COLORS
} from '../../src/utils/themeValidation.js';

describe('isValidHexColor', () => {
  describe('valid formats', () => {
    it('accepts valid 6-digit hex colors', () => {
      expect(isValidHexColor('#ff0000')).toBe(true);
      expect(isValidHexColor('#FF0000')).toBe(true);
      expect(isValidHexColor('#123abc')).toBe(true);
      expect(isValidHexColor('#ABCDEF')).toBe(true);
      expect(isValidHexColor('#000000')).toBe(true);
      expect(isValidHexColor('#ffffff')).toBe(true);
    });

    it('accepts valid 3-digit hex colors', () => {
      expect(isValidHexColor('#fff')).toBe(true);
      expect(isValidHexColor('#FFF')).toBe(true);
      expect(isValidHexColor('#000')).toBe(true);
      expect(isValidHexColor('#abc')).toBe(true);
      expect(isValidHexColor('#123')).toBe(true);
    });

    it('accepts valid 8-digit hex colors (with alpha)', () => {
      expect(isValidHexColor('#ff0000ff')).toBe(true);
      expect(isValidHexColor('#FF0000FF')).toBe(true);
      expect(isValidHexColor('#12345678')).toBe(true);
      expect(isValidHexColor('#ABCDEF00')).toBe(true);
    });

    it('accepts mixed case hex colors', () => {
      expect(isValidHexColor('#AaBbCc')).toBe(true);
      expect(isValidHexColor('#1a2B3c')).toBe(true);
    });
  });

  describe('invalid formats', () => {
    it('rejects colors missing # prefix', () => {
      expect(isValidHexColor('ff0000')).toBe(false);
      expect(isValidHexColor('fff')).toBe(false);
      expect(isValidHexColor('ABCDEF')).toBe(false);
    });

    it('rejects invalid hex characters', () => {
      expect(isValidHexColor('#gg0000')).toBe(false);
      expect(isValidHexColor('#xyz')).toBe(false);
      expect(isValidHexColor('#12345g')).toBe(false);
      expect(isValidHexColor('#fffffz')).toBe(false);
    });

    it('rejects invalid lengths', () => {
      expect(isValidHexColor('#ff')).toBe(false);        // 2 digits
      expect(isValidHexColor('#ff00')).toBe(false);      // 4 digits
      expect(isValidHexColor('#ff000')).toBe(false);     // 5 digits
      expect(isValidHexColor('#ff00000')).toBe(false);   // 7 digits
      expect(isValidHexColor('#ff0000000')).toBe(false); // 9 digits
    });

    it('rejects empty and edge cases', () => {
      expect(isValidHexColor('')).toBe(false);
      expect(isValidHexColor('#')).toBe(false);
      expect(isValidHexColor('  #fff  ')).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidHexColor(null as any)).toBe(false);
      expect(isValidHexColor(undefined as any)).toBe(false);
      expect(isValidHexColor(123 as any)).toBe(false);
      expect(isValidHexColor({} as any)).toBe(false);
      expect(isValidHexColor([] as any)).toBe(false);
    });
  });
});

describe('isValidThemeSlug', () => {
  describe('valid slugs', () => {
    it('accepts valid custom- prefixed slugs', () => {
      expect(isValidThemeSlug('custom-theme')).toBe(true);
      expect(isValidThemeSlug('custom-my-theme')).toBe(true);
      expect(isValidThemeSlug('custom-dark')).toBe(true);
      expect(isValidThemeSlug('custom-theme-123')).toBe(true);
    });

    it('accepts slugs with numbers', () => {
      expect(isValidThemeSlug('custom-theme1')).toBe(true);
      expect(isValidThemeSlug('custom-123')).toBe(true);
      expect(isValidThemeSlug('custom-theme-2024')).toBe(true);
    });

    it('accepts slugs with multiple hyphens', () => {
      expect(isValidThemeSlug('custom-my-awesome-theme')).toBe(true);
      expect(isValidThemeSlug('custom-a-b-c-d-e')).toBe(true);
    });

    it('accepts minimum valid length (8 characters)', () => {
      expect(isValidThemeSlug('custom-x')).toBe(true);
      expect(isValidThemeSlug('custom-a')).toBe(true);
    });

    it('accepts maximum valid length (50 characters)', () => {
      const maxSlug = 'custom-' + 'a'.repeat(43); // 7 + 43 = 50
      expect(isValidThemeSlug(maxSlug)).toBe(true);
    });
  });

  describe('invalid slugs', () => {
    it('rejects slugs without custom- prefix', () => {
      expect(isValidThemeSlug('theme')).toBe(false);
      expect(isValidThemeSlug('my-theme')).toBe(false);
      expect(isValidThemeSlug('custon-theme')).toBe(false);
    });

    it('rejects slugs with uppercase letters', () => {
      expect(isValidThemeSlug('custom-Theme')).toBe(false);
      expect(isValidThemeSlug('custom-THEME')).toBe(false);
      expect(isValidThemeSlug('Custom-theme')).toBe(false);
    });

    it('rejects slugs with special characters', () => {
      expect(isValidThemeSlug('custom-theme_1')).toBe(false);
      expect(isValidThemeSlug('custom-theme.1')).toBe(false);
      expect(isValidThemeSlug('custom-theme@1')).toBe(false);
      expect(isValidThemeSlug('custom-theme 1')).toBe(false);
    });

    it('rejects slugs that are too short', () => {
      expect(isValidThemeSlug('custom-')).toBe(false);  // 7 chars
      expect(isValidThemeSlug('custom')).toBe(false);   // 6 chars
      expect(isValidThemeSlug('custom-')).toBe(false);
    });

    it('rejects slugs that are too long', () => {
      const tooLong = 'custom-' + 'a'.repeat(44); // 7 + 44 = 51
      expect(isValidThemeSlug(tooLong)).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidThemeSlug(null as any)).toBe(false);
      expect(isValidThemeSlug(undefined as any)).toBe(false);
      expect(isValidThemeSlug(123 as any)).toBe(false);
    });
  });
});

describe('isValidThemeName', () => {
  describe('valid names', () => {
    it('accepts valid theme names', () => {
      expect(isValidThemeName('My Theme')).toBe(true);
      expect(isValidThemeName('Dark Theme')).toBe(true);
      expect(isValidThemeName('Theme 123')).toBe(true);
    });

    it('accepts names with special characters', () => {
      expect(isValidThemeName('Theme @ Night')).toBe(true);
      expect(isValidThemeName('My Theme!')).toBe(true);
      expect(isValidThemeName('Theme (Dark)')).toBe(true);
    });

    it('accepts minimum length (1 character after trim)', () => {
      expect(isValidThemeName('A')).toBe(true);
      expect(isValidThemeName('  X  ')).toBe(true); // Trimmed to 1 char
    });

    it('accepts maximum length (50 characters)', () => {
      expect(isValidThemeName('a'.repeat(50))).toBe(true);
    });

    it('trims whitespace before validation', () => {
      expect(isValidThemeName('  Theme  ')).toBe(true);
      expect(isValidThemeName('\tTheme\t')).toBe(true);
      expect(isValidThemeName('\n Theme \n')).toBe(true);
    });
  });

  describe('invalid names', () => {
    it('rejects empty strings', () => {
      expect(isValidThemeName('')).toBe(false);
    });

    it('rejects whitespace-only strings', () => {
      expect(isValidThemeName('   ')).toBe(false);
      expect(isValidThemeName('\t\t\t')).toBe(false);
      expect(isValidThemeName('\n\n')).toBe(false);
    });

    it('rejects names longer than 50 characters', () => {
      expect(isValidThemeName('a'.repeat(51))).toBe(false);
      expect(isValidThemeName('a'.repeat(100))).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidThemeName(null as any)).toBe(false);
      expect(isValidThemeName(undefined as any)).toBe(false);
      expect(isValidThemeName(123 as any)).toBe(false);
    });
  });
});

describe('generateThemeSlug', () => {
  it('generates slug from simple names', () => {
    expect(generateThemeSlug('My Theme')).toBe('custom-my-theme');
    expect(generateThemeSlug('Dark Theme')).toBe('custom-dark-theme');
    expect(generateThemeSlug('Light')).toBe('custom-light');
  });

  it('converts to lowercase', () => {
    expect(generateThemeSlug('UPPERCASE')).toBe('custom-uppercase');
    expect(generateThemeSlug('MiXeD cAsE')).toBe('custom-mixed-case');
  });

  it('replaces spaces with hyphens', () => {
    expect(generateThemeSlug('Multiple Word Theme')).toBe('custom-multiple-word-theme');
    expect(generateThemeSlug('A B C D')).toBe('custom-a-b-c-d');
  });

  it('removes special characters', () => {
    expect(generateThemeSlug('Theme@Night')).toBe('custom-themenight');
    expect(generateThemeSlug('My Theme!')).toBe('custom-my-theme');
    expect(generateThemeSlug('Theme (Dark)')).toBe('custom-theme-dark');
    expect(generateThemeSlug('Theme#1')).toBe('custom-theme1');
  });

  it('handles multiple consecutive spaces', () => {
    expect(generateThemeSlug('Multiple    Spaces')).toBe('custom-multiple-spaces');
    expect(generateThemeSlug('Too     Many     Spaces')).toBe('custom-too-many-spaces');
  });

  it('removes leading and trailing hyphens', () => {
    expect(generateThemeSlug('-Leading')).toBe('custom-leading');
    expect(generateThemeSlug('Trailing-')).toBe('custom-trailing');
    expect(generateThemeSlug('-Both-')).toBe('custom-both');
  });

  it('collapses multiple hyphens', () => {
    expect(generateThemeSlug('Multiple---Hyphens')).toBe('custom-multiple-hyphens');
    expect(generateThemeSlug('Too-----Many')).toBe('custom-too-many');
  });

  it('trims whitespace', () => {
    expect(generateThemeSlug('  Trimmed  ')).toBe('custom-trimmed');
    expect(generateThemeSlug('\tTabbed\t')).toBe('custom-tabbed');
  });

  it('does not duplicate custom- prefix', () => {
    expect(generateThemeSlug('custom-already')).toBe('custom-already');
    expect(generateThemeSlug('custom-theme')).toBe('custom-theme');
  });

  it('truncates to 50 characters max', () => {
    const longName = 'a'.repeat(100);
    const slug = generateThemeSlug(longName);
    expect(slug.length).toBe(50);
    expect(slug.startsWith('custom-')).toBe(true);
  });

  it('handles edge cases', () => {
    expect(generateThemeSlug('')).toBe('custom-');
    expect(generateThemeSlug('   ')).toBe('custom-');
    expect(generateThemeSlug('123')).toBe('custom-123');
    expect(generateThemeSlug('@@@')).toBe('custom-');
  });
});

describe('REQUIRED_THEME_COLORS', () => {
  it('exports exactly 26 required colors', () => {
    expect(REQUIRED_THEME_COLORS).toHaveLength(26);
  });

  it('includes all base colors', () => {
    expect(REQUIRED_THEME_COLORS).toContain('base');
    expect(REQUIRED_THEME_COLORS).toContain('mantle');
    expect(REQUIRED_THEME_COLORS).toContain('crust');
  });

  it('includes all text colors', () => {
    expect(REQUIRED_THEME_COLORS).toContain('text');
    expect(REQUIRED_THEME_COLORS).toContain('subtext1');
    expect(REQUIRED_THEME_COLORS).toContain('subtext0');
  });

  it('includes all overlay colors', () => {
    expect(REQUIRED_THEME_COLORS).toContain('overlay2');
    expect(REQUIRED_THEME_COLORS).toContain('overlay1');
    expect(REQUIRED_THEME_COLORS).toContain('overlay0');
  });

  it('includes all surface colors', () => {
    expect(REQUIRED_THEME_COLORS).toContain('surface2');
    expect(REQUIRED_THEME_COLORS).toContain('surface1');
    expect(REQUIRED_THEME_COLORS).toContain('surface0');
  });

  it('includes all accent colors', () => {
    expect(REQUIRED_THEME_COLORS).toContain('lavender');
    expect(REQUIRED_THEME_COLORS).toContain('blue');
    expect(REQUIRED_THEME_COLORS).toContain('sapphire');
    expect(REQUIRED_THEME_COLORS).toContain('sky');
    expect(REQUIRED_THEME_COLORS).toContain('teal');
    expect(REQUIRED_THEME_COLORS).toContain('green');
    expect(REQUIRED_THEME_COLORS).toContain('yellow');
    expect(REQUIRED_THEME_COLORS).toContain('peach');
    expect(REQUIRED_THEME_COLORS).toContain('maroon');
    expect(REQUIRED_THEME_COLORS).toContain('red');
    expect(REQUIRED_THEME_COLORS).toContain('mauve');
    expect(REQUIRED_THEME_COLORS).toContain('pink');
    expect(REQUIRED_THEME_COLORS).toContain('flamingo');
    expect(REQUIRED_THEME_COLORS).toContain('rosewater');
  });
});

describe('validateThemeDefinition', () => {
  const validTheme = {
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
    text: '#cdd6f4',
    subtext1: '#bac2de',
    subtext0: '#a6adc8',
    overlay2: '#9399b2',
    overlay1: '#7f849c',
    overlay0: '#6c7086',
    surface2: '#585b70',
    surface1: '#45475a',
    surface0: '#313244',
    lavender: '#b4befe',
    blue: '#89b4fa',
    sapphire: '#74c7ec',
    sky: '#89dceb',
    teal: '#94e2d5',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    peach: '#fab387',
    maroon: '#eba0ac',
    red: '#f38ba8',
    mauve: '#cba6f7',
    pink: '#f5c2e7',
    flamingo: '#f2cdcd',
    rosewater: '#f5e0dc'
  };

  describe('valid themes', () => {
    it('accepts valid theme with all 26 colors', () => {
      const result = validateThemeDefinition(validTheme);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with 3-digit hex colors', () => {
      const themeWith3Digit = { ...validTheme, base: '#fff', text: '#000' };
      const result = validateThemeDefinition(themeWith3Digit);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with 8-digit hex colors (with alpha)', () => {
      const themeWithAlpha = { ...validTheme, base: '#1e1e2eff' };
      const result = validateThemeDefinition(themeWithAlpha);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with mixed case hex colors', () => {
      const mixedCase = { ...validTheme, base: '#FF0000', text: '#AbCdEf' };
      const result = validateThemeDefinition(mixedCase);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('invalid themes - missing colors', () => {
    it('rejects theme missing single color', () => {
      const { base, ...incomplete } = validTheme;
      const result = validateThemeDefinition(incomplete);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required colors: base');
    });

    it('rejects theme missing multiple colors', () => {
      const { base, text, blue, ...incomplete } = validTheme;
      const result = validateThemeDefinition(incomplete);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required colors:'))).toBe(true);
      expect(result.errors.some(e => e.includes('base'))).toBe(true);
      expect(result.errors.some(e => e.includes('text'))).toBe(true);
      expect(result.errors.some(e => e.includes('blue'))).toBe(true);
    });

    it('rejects completely empty object', () => {
      const result = validateThemeDefinition({});
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required colors:'))).toBe(true);
    });
  });

  describe('invalid themes - invalid colors', () => {
    it('rejects theme with single invalid hex color', () => {
      const invalidColor = { ...validTheme, base: 'not-a-color' };
      const result = validateThemeDefinition(invalidColor);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes("Invalid hex color for 'base'"))).toBe(true);
    });

    it('rejects theme with multiple invalid colors', () => {
      const invalidColors = {
        ...validTheme,
        base: 'invalid1',
        text: 'invalid2',
        blue: '#gg0000'
      };
      const result = validateThemeDefinition(invalidColors);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
      expect(result.errors.some(e => e.includes("base"))).toBe(true);
      expect(result.errors.some(e => e.includes("text"))).toBe(true);
      expect(result.errors.some(e => e.includes("blue"))).toBe(true);
    });

    it('rejects colors missing # prefix', () => {
      const missingHash = { ...validTheme, base: 'ff0000' };
      const result = validateThemeDefinition(missingHash);
      expect(result.isValid).toBe(false);
    });
  });

  describe('invalid themes - extra properties', () => {
    it('rejects theme with single extra property', () => {
      const extra = { ...validTheme, extraProp: '#ffffff' };
      const result = validateThemeDefinition(extra);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Unexpected properties:'))).toBe(true);
      expect(result.errors.some(e => e.includes('extraProp'))).toBe(true);
    });

    it('rejects theme with multiple extra properties', () => {
      const extra = { ...validTheme, extra1: '#fff', extra2: '#000' };
      const result = validateThemeDefinition(extra);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Unexpected properties:'))).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects null', () => {
      const result = validateThemeDefinition(null);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Theme definition must be an object');
    });

    it('rejects undefined', () => {
      const result = validateThemeDefinition(undefined);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Theme definition must be an object');
    });

    it('rejects string', () => {
      const result = validateThemeDefinition('not an object');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Theme definition must be an object');
    });

    it('rejects number', () => {
      const result = validateThemeDefinition(123);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Theme definition must be an object');
    });

    it('rejects array', () => {
      const result = validateThemeDefinition([]);
      expect(result.isValid).toBe(false);
      // Arrays are objects in JavaScript, so this will fail with missing colors instead
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('Missing required colors:'))).toBe(true);
    });
  });

  describe('combined errors', () => {
    it('reports missing colors, invalid colors, and extra properties', () => {
      const problematic = {
        base: 'invalid',
        text: '#ffffff',
        // missing 24 other colors
        extraProperty: '#000000'
      };
      const result = validateThemeDefinition(problematic);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });
});

describe('isThemeDefinition', () => {
  const validTheme = {
    base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
    text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8',
    overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086',
    surface2: '#585b70', surface1: '#45475a', surface0: '#313244',
    lavender: '#b4befe', blue: '#89b4fa', sapphire: '#74c7ec',
    sky: '#89dceb', teal: '#94e2d5', green: '#a6e3a1',
    yellow: '#f9e2af', peach: '#fab387', maroon: '#eba0ac',
    red: '#f38ba8', mauve: '#cba6f7', pink: '#f5c2e7',
    flamingo: '#f2cdcd', rosewater: '#f5e0dc'
  };

  it('returns true for valid theme definition', () => {
    expect(isThemeDefinition(validTheme)).toBe(true);
  });

  it('returns false for invalid theme definition', () => {
    const { base, ...invalid } = validTheme;
    expect(isThemeDefinition(invalid)).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(isThemeDefinition(null)).toBe(false);
    expect(isThemeDefinition(undefined)).toBe(false);
    expect(isThemeDefinition('string')).toBe(false);
    expect(isThemeDefinition(123)).toBe(false);
  });

  it('can be used as type guard', () => {
    const maybeTheme: any = validTheme;
    if (isThemeDefinition(maybeTheme)) {
      // TypeScript should recognize this as ThemeDefinition
      expect(maybeTheme.base).toBeDefined();
      expect(maybeTheme.text).toBeDefined();
    }
  });
});

describe('normalizeHexColor', () => {
  describe('3-digit hex expansion', () => {
    it('expands 3-digit hex to 6-digit uppercase', () => {
      expect(normalizeHexColor('#fff')).toBe('#FFFFFF');
      expect(normalizeHexColor('#000')).toBe('#000000');
      expect(normalizeHexColor('#abc')).toBe('#AABBCC');
      expect(normalizeHexColor('#123')).toBe('#112233');
      expect(normalizeHexColor('#f0a')).toBe('#FF00AA');
    });

    it('expands lowercase 3-digit to uppercase 6-digit', () => {
      expect(normalizeHexColor('#def')).toBe('#DDEEFF');
    });

    it('expands uppercase 3-digit to uppercase 6-digit', () => {
      expect(normalizeHexColor('#ABC')).toBe('#AABBCC');
    });
  });

  describe('6-digit hex normalization', () => {
    it('converts lowercase to uppercase', () => {
      expect(normalizeHexColor('#ff0000')).toBe('#FF0000');
      expect(normalizeHexColor('#abc123')).toBe('#ABC123');
      expect(normalizeHexColor('#def456')).toBe('#DEF456');
    });

    it('preserves uppercase', () => {
      expect(normalizeHexColor('#FF0000')).toBe('#FF0000');
      expect(normalizeHexColor('#ABCDEF')).toBe('#ABCDEF');
    });

    it('handles mixed case', () => {
      expect(normalizeHexColor('#AaBbCc')).toBe('#AABBCC');
      expect(normalizeHexColor('#1a2B3c')).toBe('#1A2B3C');
    });
  });

  describe('8-digit hex normalization', () => {
    it('converts 8-digit to uppercase', () => {
      expect(normalizeHexColor('#ff0000ff')).toBe('#FF0000FF');
      expect(normalizeHexColor('#abc12380')).toBe('#ABC12380');
    });
  });

  describe('invalid colors', () => {
    it('returns original string for invalid colors', () => {
      expect(normalizeHexColor('invalid')).toBe('invalid');
      expect(normalizeHexColor('ff0000')).toBe('ff0000');
      expect(normalizeHexColor('#gg0000')).toBe('#gg0000');
      expect(normalizeHexColor('#ff')).toBe('#ff');
      expect(normalizeHexColor('')).toBe('');
    });
  });
});

describe('normalizeThemeDefinition', () => {
  it('normalizes all colors in a theme', () => {
    const theme = {
      base: '#fff', mantle: '#ff0000', crust: '#ABC',
      text: '#000', subtext1: '#123456', subtext0: '#AbCdEf',
      overlay2: '#999', overlay1: '#888', overlay0: '#777',
      surface2: '#666', surface1: '#555', surface0: '#444',
      lavender: '#abc', blue: '#def', sapphire: '#123',
      sky: '#456', teal: '#789', green: '#0a0',
      yellow: '#ff0', peach: '#f80', maroon: '#a00',
      red: '#f00', mauve: '#a0f', pink: '#f0a',
      flamingo: '#faa', rosewater: '#fcc'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    expect(normalized.base).toBe('#FFFFFF');
    expect(normalized.mantle).toBe('#FF0000');
    expect(normalized.crust).toBe('#AABBCC');
    expect(normalized.text).toBe('#000000');
    expect(normalized.subtext1).toBe('#123456');
    expect(normalized.subtext0).toBe('#ABCDEF');
  });

  it('handles already normalized theme', () => {
    const theme = {
      base: '#FFFFFF', mantle: '#000000', crust: '#AABBCC',
      text: '#112233', subtext1: '#445566', subtext0: '#778899',
      overlay2: '#AABBCC', overlay1: '#DDEEFF', overlay0: '#123456',
      surface2: '#789ABC', surface1: '#DEF012', surface0: '#345678',
      lavender: '#9ABCDE', blue: '#F01234', sapphire: '#567890',
      sky: '#ABCDEF', teal: '#123456', green: '#789ABC',
      yellow: '#DEF012', peach: '#345678', maroon: '#9ABCDE',
      red: '#F01234', mauve: '#567890', pink: '#ABCDEF',
      flamingo: '#123456', rosewater: '#789ABC'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    expect(normalized.base).toBe('#FFFFFF');
    expect(normalized.text).toBe('#112233');
  });

  it('only normalizes the 26 required colors', () => {
    const theme = {
      base: '#fff', mantle: '#000', crust: '#abc',
      text: '#123', subtext1: '#456', subtext0: '#789',
      overlay2: '#aaa', overlay1: '#bbb', overlay0: '#ccc',
      surface2: '#ddd', surface1: '#eee', surface0: '#fff',
      lavender: '#111', blue: '#222', sapphire: '#333',
      sky: '#444', teal: '#555', green: '#666',
      yellow: '#777', peach: '#888', maroon: '#999',
      red: '#aaa', mauve: '#bbb', pink: '#ccc',
      flamingo: '#ddd', rosewater: '#eee'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    // Should have exactly 26 properties
    expect(Object.keys(normalized)).toHaveLength(26);
  });
});
