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
  isLegacyThemeDefinition,
  migrateLegacyThemeDefinition,
  normalizeHexColor,
  normalizeThemeDefinition,
  REQUIRED_THEME_COLORS,
  OPTIONAL_THEME_COLORS
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

  it('names every key by role, never by swatch', () => {
    // The point of #4567. A key named for a hue makes the author write
    // `blue: '#ff0000'` to get a red accent, and makes every later reader work
    // out that `blue` meant "accent". No swatch name may come back.
    const swatchNames = [
      'base', 'mantle', 'crust', 'subtext1', 'subtext0',
      'overlay2', 'overlay1', 'overlay0', 'surface0', 'surface1', 'surface2',
      'lavender', 'blue', 'sapphire', 'sky', 'teal', 'green',
      'yellow', 'peach', 'maroon', 'red', 'mauve', 'pink',
      'flamingo', 'rosewater'
    ];
    const leaked = swatchNames.filter(
      (n) => (REQUIRED_THEME_COLORS as readonly string[]).includes(n)
    );
    expect(leaked).toEqual([]);
  });

  it('includes all background and surface roles', () => {
    for (const key of ['bg', 'bgRaised', 'bgSunken', 'surface',
                       'surfaceHover', 'surfaceActive', 'surfaceInactive']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });

  it('includes all text roles', () => {
    for (const key of ['text', 'textMuted', 'textSubtle', 'textDisabled', 'textFaint']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });

  it('includes all line roles', () => {
    for (const key of ['border', 'borderStrong', 'borderSubtle']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });

  it('includes all accent roles', () => {
    for (const key of ['accent', 'accentHover', 'accentAlt', 'accentMuted', 'accentText']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });

  it('includes all status roles', () => {
    for (const key of ['success', 'error', 'warning', 'caution', 'info', 'danger']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });

  it('separates the roles that used to share one swatch', () => {
    // These collapsed onto `overlay0` and `surface1`, so a theme could not
    // lighten its chrome without also lightening faint text. They still share
    // a VALUE in the built-ins; what changed is that they can be moved apart.
    for (const key of ['textFaint', 'borderSubtle', 'surfaceInactive',
                       'border', 'surfaceHover']) {
      expect(REQUIRED_THEME_COLORS).toContain(key);
    }
  });
});

describe('OPTIONAL_THEME_COLORS', () => {
  it('exports the categorical scale plus the chat bubble overrides', () => {
    expect(OPTIONAL_THEME_COLORS).toHaveLength(12);
  });

  it('includes all eight categorical slots', () => {
    for (let i = 1; i <= 8; i++) {
      expect(OPTIONAL_THEME_COLORS).toContain(`chart${i}`);
    }
  });

  it('includes all chat bubble color variables', () => {
    expect(OPTIONAL_THEME_COLORS).toContain('chatBubbleSentBg');
    expect(OPTIONAL_THEME_COLORS).toContain('chatBubbleSentText');
    expect(OPTIONAL_THEME_COLORS).toContain('chatBubbleReceivedBg');
    expect(OPTIONAL_THEME_COLORS).toContain('chatBubbleReceivedText');
  });
});

describe('legacy swatch-keyed definitions', () => {
  const legacy = {
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

  it('recognises a swatch-keyed definition', () => {
    expect(isLegacyThemeDefinition(legacy)).toBe(true);
  });

  it('does not treat a role-keyed definition as legacy', () => {
    // Detection keys off what only the OLD format has. Keying off a MISSING
    // new key would rewrite a half-written theme into nonsense.
    expect(isLegacyThemeDefinition({ accent: '#ff0000', bg: '#000000' })).toBe(false);
    expect(isLegacyThemeDefinition({ accent: '#ff0000' })).toBe(false);
    expect(isLegacyThemeDefinition({})).toBe(false);
    expect(isLegacyThemeDefinition(null)).toBe(false);
  });

  it('translates into a definition that validates', () => {
    const migrated = migrateLegacyThemeDefinition(legacy);
    const result = validateThemeDefinition(migrated);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('preserves the swatch each role used to resolve to', () => {
    const m = migrateLegacyThemeDefinition(legacy);
    expect(m.accent).toBe(legacy.blue);
    expect(m.accentAlt).toBe(legacy.mauve);
    expect(m.error).toBe(legacy.red);
    expect(m.success).toBe(legacy.green);
    expect(m.bg).toBe(legacy.base);
    expect(m.text).toBe(legacy.text);
  });

  it('fans one swatch out to every role that shared it', () => {
    const m = migrateLegacyThemeDefinition(legacy);
    expect([m.textFaint, m.borderSubtle, m.surfaceInactive])
      .toEqual([legacy.overlay0, legacy.overlay0, legacy.overlay0]);
    expect([m.surfaceHover, m.border]).toEqual([legacy.surface1, legacy.surface1]);
  });

  it("carries the author's categorical choices forward", () => {
    const m = migrateLegacyThemeDefinition(legacy);
    expect(m.chart1).toBe(legacy.blue);
    expect(m.chart8).toBe(legacy.rosewater);
  });

  it('is a no-op on an already-migrated definition', () => {
    const once = migrateLegacyThemeDefinition(legacy);
    expect(migrateLegacyThemeDefinition(once)).toEqual(once);
  });
});

describe('validateThemeDefinition', () => {
  const validTheme = {
    bg: '#1e1e2e',
    bgRaised: '#181825',
    bgSunken: '#11111b',
    surface: '#313244',
    surfaceHover: '#45475a',
    surfaceActive: '#585b70',
    surfaceInactive: '#6c7086',
    text: '#cdd6f4',
    textMuted: '#bac2de',
    textSubtle: '#a6adc8',
    textDisabled: '#7f849c',
    textFaint: '#6c7086',
    border: '#45475a',
    borderStrong: '#585b70',
    borderSubtle: '#6c7086',
    accent: '#89b4fa',
    accentHover: '#74c7ec',
    accentAlt: '#cba6f7',
    accentMuted: '#b4befe',
    accentText: '#000000',
    success: '#a6e3a1',
    error: '#f38ba8',
    warning: '#f9e2af',
    caution: '#fab387',
    info: '#89dceb',
    danger: '#eba0ac',
    chart1: '#89b4fa',
    chart2: '#cba6f7',
    chart3: '#a6e3a1',
    chart4: '#fab387',
    chart5: '#f9e2af',
    chart6: '#74c7ec',
    chart7: '#eba0ac',
    chart8: '#f5e0dc'
  };

  describe('valid themes', () => {
    it('accepts valid theme with all 26 colors', () => {
      const result = validateThemeDefinition(validTheme);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with 3-digit hex colors', () => {
      const themeWith3Digit = { ...validTheme, bg: '#fff', text: '#000' };
      const result = validateThemeDefinition(themeWith3Digit);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with 8-digit hex colors (with alpha)', () => {
      const themeWithAlpha = { ...validTheme, bg: '#1e1e2eff' };
      const result = validateThemeDefinition(themeWithAlpha);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with mixed case hex colors', () => {
      const mixedCase = { ...validTheme, bg: '#FF0000', text: '#AbCdEf' };
      const result = validateThemeDefinition(mixedCase);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('invalid themes - missing colors', () => {
    it('rejects theme missing single color', () => {
      const { bg, ...incomplete } = validTheme;
      const result = validateThemeDefinition(incomplete);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required colors: bg');
    });

    it('rejects theme missing multiple colors', () => {
      const { bg, text, accent, ...incomplete } = validTheme;
      const result = validateThemeDefinition(incomplete);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required colors:'))).toBe(true);
      expect(result.errors.some(e => e.includes('bg'))).toBe(true);
      expect(result.errors.some(e => e.includes('text'))).toBe(true);
      expect(result.errors.some(e => e.includes('accent'))).toBe(true);
    });

    it('rejects completely empty object', () => {
      const result = validateThemeDefinition({});
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required colors:'))).toBe(true);
    });
  });

  describe('invalid themes - invalid colors', () => {
    it('rejects theme with single invalid hex color', () => {
      const invalidColor = { ...validTheme, bg: 'not-a-color' };
      const result = validateThemeDefinition(invalidColor);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes("Invalid hex color for 'bg'"))).toBe(true);
    });

    it('rejects theme with multiple invalid colors', () => {
      const invalidColors = {
        ...validTheme,
        bg: 'invalid1',
        text: 'invalid2',
        accent: '#gg0000'
      };
      const result = validateThemeDefinition(invalidColors);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
      expect(result.errors.some(e => e.includes("bg"))).toBe(true);
      expect(result.errors.some(e => e.includes("text"))).toBe(true);
      expect(result.errors.some(e => e.includes("accent"))).toBe(true);
    });

    it('rejects colors missing # prefix', () => {
      const missingHash = { ...validTheme, bg: 'ff0000' };
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
        bg: 'invalid',
        text: '#ffffff',
        // missing 24 other colors
        extraProperty: '#000000'
      };
      const result = validateThemeDefinition(problematic);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });

  describe('optional colors', () => {
    it('accepts theme with valid optional chat bubble colors', () => {
      const themeWithOptional = {
        ...validTheme,
        chatBubbleSentBg: '#ff0000',
        chatBubbleSentText: '#ffffff',
        chatBubbleReceivedBg: '#00ff00',
        chatBubbleReceivedText: '#000000'
      };
      const result = validateThemeDefinition(themeWithOptional);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts theme with only some optional colors', () => {
      const themeWithPartial = {
        ...validTheme,
        chatBubbleSentBg: '#ff0000'
      };
      const result = validateThemeDefinition(themeWithPartial);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects invalid hex for optional colors', () => {
      const themeWithBadOptional = {
        ...validTheme,
        chatBubbleSentBg: 'not-a-color'
      };
      const result = validateThemeDefinition(themeWithBadOptional);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes("Invalid hex color for 'chatBubbleSentBg'"))).toBe(true);
    });

    it('still rejects truly unknown properties', () => {
      const themeWithUnknown = {
        ...validTheme,
        chatBubbleSentBg: '#ff0000',
        totallyUnknownProp: '#000000'
      };
      const result = validateThemeDefinition(themeWithUnknown);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Unexpected properties'))).toBe(true);
      expect(result.errors.some(e => e.includes('totallyUnknownProp'))).toBe(true);
    });
  });
});

describe('isThemeDefinition', () => {
  const validTheme = {
    bg: '#1e1e2e',
    bgRaised: '#181825',
    bgSunken: '#11111b',
    surface: '#313244',
    surfaceHover: '#45475a',
    surfaceActive: '#585b70',
    surfaceInactive: '#6c7086',
    text: '#cdd6f4',
    textMuted: '#bac2de',
    textSubtle: '#a6adc8',
    textDisabled: '#7f849c',
    textFaint: '#6c7086',
    border: '#45475a',
    borderStrong: '#585b70',
    borderSubtle: '#6c7086',
    accent: '#89b4fa',
    accentHover: '#74c7ec',
    accentAlt: '#cba6f7',
    accentMuted: '#b4befe',
    accentText: '#000000',
    success: '#a6e3a1',
    error: '#f38ba8',
    warning: '#f9e2af',
    caution: '#fab387',
    info: '#89dceb',
    danger: '#eba0ac'
  };

  it('returns true for valid theme definition', () => {
    expect(isThemeDefinition(validTheme)).toBe(true);
  });

  it('returns false for invalid theme definition', () => {
    const { bg, ...invalid } = validTheme;
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
      expect(maybeTheme.bg).toBeDefined();
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
      bg: '#fff',
      bgRaised: '#ff0000',
      bgSunken: '#ABC',
      surface: '#444',
      surfaceHover: '#555',
      surfaceActive: '#666',
      surfaceInactive: '#777',
      text: '#000',
      textMuted: '#123456',
      textSubtle: '#AbCdEf',
      textDisabled: '#888',
      textFaint: '#777',
      border: '#555',
      borderStrong: '#666',
      borderSubtle: '#777',
      accent: '#def',
      accentHover: '#123',
      accentAlt: '#a0f',
      accentMuted: '#abc',
      accentText: '#000000',
      success: '#0a0',
      error: '#f00',
      warning: '#ff0',
      caution: '#f80',
      info: '#456',
      danger: '#a00'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    expect(normalized.bg).toBe('#FFFFFF');
    expect(normalized.bgRaised).toBe('#FF0000');
    expect(normalized.bgSunken).toBe('#AABBCC');
    expect(normalized.text).toBe('#000000');
    expect(normalized.textMuted).toBe('#123456');
    expect(normalized.textSubtle).toBe('#ABCDEF');
  });

  it('handles already normalized theme', () => {
    const theme = {
      bg: '#FFFFFF',
      bgRaised: '#000000',
      bgSunken: '#AABBCC',
      surface: '#345678',
      surfaceHover: '#DEF012',
      surfaceActive: '#789ABC',
      surfaceInactive: '#123456',
      text: '#112233',
      textMuted: '#445566',
      textSubtle: '#778899',
      textDisabled: '#DDEEFF',
      textFaint: '#123456',
      border: '#DEF012',
      borderStrong: '#789ABC',
      borderSubtle: '#123456',
      accent: '#F01234',
      accentHover: '#567890',
      accentAlt: '#567890',
      accentMuted: '#9ABCDE',
      accentText: '#000000',
      success: '#789ABC',
      error: '#F01234',
      warning: '#DEF012',
      caution: '#345678',
      info: '#ABCDEF',
      danger: '#9ABCDE'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    expect(normalized.bg).toBe('#FFFFFF');
    expect(normalized.text).toBe('#112233');
  });

  it('only normalizes the 26 required colors when no optional present', () => {
    const theme = {
      bg: '#fff',
      bgRaised: '#000',
      bgSunken: '#abc',
      surface: '#fff',
      surfaceHover: '#eee',
      surfaceActive: '#ddd',
      surfaceInactive: '#ccc',
      text: '#123',
      textMuted: '#456',
      textSubtle: '#789',
      textDisabled: '#bbb',
      textFaint: '#ccc',
      border: '#eee',
      borderStrong: '#ddd',
      borderSubtle: '#ccc',
      accent: '#222',
      accentHover: '#333',
      accentAlt: '#bbb',
      accentMuted: '#111',
      accentText: '#000000',
      success: '#666',
      error: '#aaa',
      warning: '#777',
      caution: '#888',
      info: '#444',
      danger: '#999'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    // Should have exactly 26 properties
    expect(Object.keys(normalized)).toHaveLength(26);
  });

  it('preserves and normalizes optional colors when present', () => {
    const theme = {
      bg: '#fff',
      bgRaised: '#000',
      bgSunken: '#abc',
      surface: '#fff',
      surfaceHover: '#eee',
      surfaceActive: '#ddd',
      surfaceInactive: '#ccc',
      text: '#123',
      textMuted: '#456',
      textSubtle: '#789',
      textDisabled: '#bbb',
      textFaint: '#ccc',
      border: '#eee',
      borderStrong: '#ddd',
      borderSubtle: '#ccc',
      accent: '#222',
      accentHover: '#333',
      accentAlt: '#bbb',
      accentMuted: '#111',
      accentText: '#000000',
      success: '#666',
      error: '#aaa',
      warning: '#777',
      caution: '#888',
      info: '#444',
      danger: '#999',
      chatBubbleSentBg: '#f00',
      chatBubbleSentText: '#abc'
    };

    const normalized = normalizeThemeDefinition(theme as any);

    // Should have 26 required + 2 optional = 28
    expect(Object.keys(normalized)).toHaveLength(28);
    expect((normalized as any).chatBubbleSentBg).toBe('#FF0000');
    expect((normalized as any).chatBubbleSentText).toBe('#AABBCC');
  });
});

describe('migrateLegacyThemeDefinition — accentText', () => {
  const swatchOnly = {
    base: '#1e1e2e', crust: '#11111b', mantle: '#181825',
    subtext0: '#a6adc8', subtext1: '#bac2de', surface0: '#313244',
    overlay0: '#6c7086', overlay1: '#7f849c'
  };

  it('defaults to black when the legacy definition has none', () => {
    // There was no swatch to migrate from: accent-text was one global value,
    // fixed black, painted on bright fills.
    expect(migrateLegacyThemeDefinition(swatchOnly).accentText).toBe('#000000');
  });

  it('keeps a value the definition already carries', () => {
    // A hand-edited hybrid can have one, and clobbering it would lose the
    // author's choice for no reason.
    const hybrid = { ...swatchOnly, accentText: '#ffffff' };
    expect(migrateLegacyThemeDefinition(hybrid).accentText).toBe('#ffffff');
  });
});
