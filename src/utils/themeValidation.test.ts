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
} from './themeValidation';

// Helper to create a valid theme definition for testing
function createValidThemeDefinition(): Record<string, string> {
  const definition: Record<string, string> = {};
  for (const color of REQUIRED_THEME_COLORS) {
    definition[color] = '#AABBCC';
  }
  return definition;
}

describe('themeValidation utilities', () => {
  describe('isValidHexColor', () => {
    it('should accept valid 6-character hex colors', () => {
      expect(isValidHexColor('#AABBCC')).toBe(true);
      expect(isValidHexColor('#aabbcc')).toBe(true);
      expect(isValidHexColor('#000000')).toBe(true);
      expect(isValidHexColor('#FFFFFF')).toBe(true);
      expect(isValidHexColor('#123456')).toBe(true);
    });

    it('should accept valid 3-character hex colors', () => {
      expect(isValidHexColor('#ABC')).toBe(true);
      expect(isValidHexColor('#abc')).toBe(true);
      expect(isValidHexColor('#000')).toBe(true);
      expect(isValidHexColor('#FFF')).toBe(true);
    });

    it('should accept valid 8-character hex colors (with alpha)', () => {
      expect(isValidHexColor('#AABBCCDD')).toBe(true);
      expect(isValidHexColor('#00000000')).toBe(true);
      expect(isValidHexColor('#FFFFFFFF')).toBe(true);
    });

    it('should reject colors without # prefix', () => {
      expect(isValidHexColor('AABBCC')).toBe(false);
      expect(isValidHexColor('abc')).toBe(false);
    });

    it('should reject invalid hex characters', () => {
      expect(isValidHexColor('#GGHHII')).toBe(false);
      expect(isValidHexColor('#XYZ')).toBe(false);
      expect(isValidHexColor('#12345G')).toBe(false);
    });

    it('should reject invalid lengths', () => {
      expect(isValidHexColor('#A')).toBe(false);
      expect(isValidHexColor('#AB')).toBe(false);
      expect(isValidHexColor('#ABCD')).toBe(false);
      expect(isValidHexColor('#ABCDE')).toBe(false);
      expect(isValidHexColor('#ABCDEFGH')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidHexColor(null as unknown as string)).toBe(false);
      expect(isValidHexColor(undefined as unknown as string)).toBe(false);
      expect(isValidHexColor(123 as unknown as string)).toBe(false);
    });
  });

  describe('isValidThemeSlug', () => {
    it('should accept valid slugs with custom- prefix', () => {
      expect(isValidThemeSlug('custom-my-theme')).toBe(true);
      expect(isValidThemeSlug('custom-dark-mode')).toBe(true);
      expect(isValidThemeSlug('custom-123')).toBe(true);
      expect(isValidThemeSlug('custom-a')).toBe(true);
    });

    it('should reject slugs without custom- prefix', () => {
      expect(isValidThemeSlug('my-theme')).toBe(false);
      expect(isValidThemeSlug('dark-mode')).toBe(false);
      expect(isValidThemeSlug('catppuccin-latte')).toBe(false);
    });

    it('should reject slugs that are too short', () => {
      expect(isValidThemeSlug('custom-')).toBe(false);
      expect(isValidThemeSlug('custom')).toBe(false);
    });

    it('should reject slugs that are too long', () => {
      const longSlug = 'custom-' + 'a'.repeat(50);
      expect(isValidThemeSlug(longSlug)).toBe(false);
    });

    it('should reject slugs with uppercase letters', () => {
      expect(isValidThemeSlug('custom-MyTheme')).toBe(false);
      expect(isValidThemeSlug('Custom-theme')).toBe(false);
    });

    it('should reject slugs with special characters', () => {
      expect(isValidThemeSlug('custom-my_theme')).toBe(false);
      expect(isValidThemeSlug('custom-my.theme')).toBe(false);
      expect(isValidThemeSlug('custom-my theme')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(isValidThemeSlug(null as unknown as string)).toBe(false);
      expect(isValidThemeSlug(undefined as unknown as string)).toBe(false);
    });
  });

  describe('isValidThemeName', () => {
    it('should accept valid theme names', () => {
      expect(isValidThemeName('My Theme')).toBe(true);
      expect(isValidThemeName('Dark Mode')).toBe(true);
      expect(isValidThemeName('A')).toBe(true);
      expect(isValidThemeName('Theme 123')).toBe(true);
    });

    it('should reject empty names', () => {
      expect(isValidThemeName('')).toBe(false);
      expect(isValidThemeName('   ')).toBe(false);
    });

    it('should reject names that are too long', () => {
      const longName = 'a'.repeat(51);
      expect(isValidThemeName(longName)).toBe(false);
    });

    it('should accept names at the max length', () => {
      const maxName = 'a'.repeat(50);
      expect(isValidThemeName(maxName)).toBe(true);
    });

    it('should reject non-string inputs', () => {
      expect(isValidThemeName(null as unknown as string)).toBe(false);
      expect(isValidThemeName(undefined as unknown as string)).toBe(false);
    });
  });

  describe('generateThemeSlug', () => {
    it('should generate valid slugs from names', () => {
      expect(generateThemeSlug('My Theme')).toBe('custom-my-theme');
      expect(generateThemeSlug('Dark Mode')).toBe('custom-dark-mode');
    });

    it('should handle special characters', () => {
      expect(generateThemeSlug('My Theme!')).toBe('custom-my-theme');
      expect(generateThemeSlug("Theme's Best")).toBe('custom-themes-best');
    });

    it('should handle multiple spaces', () => {
      expect(generateThemeSlug('My   Theme')).toBe('custom-my-theme');
    });

    it('should handle leading/trailing spaces', () => {
      expect(generateThemeSlug('  My Theme  ')).toBe('custom-my-theme');
    });

    it('should not duplicate custom- prefix', () => {
      expect(generateThemeSlug('custom-theme')).toBe('custom-theme');
    });

    it('should truncate long names', () => {
      const longName = 'a'.repeat(100);
      const slug = generateThemeSlug(longName);
      expect(slug.length).toBeLessThanOrEqual(50);
    });
  });

  describe('validateThemeDefinition', () => {
    it('should validate a complete theme definition', () => {
      const validTheme = createValidThemeDefinition();
      const result = validateThemeDefinition(validTheme);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject non-object inputs', () => {
      expect(validateThemeDefinition(null).isValid).toBe(false);
      expect(validateThemeDefinition(undefined).isValid).toBe(false);
      expect(validateThemeDefinition('string').isValid).toBe(false);
    });

    it('should report missing colors', () => {
      const incompleteTheme = { base: '#AABBCC' };
      const result = validateThemeDefinition(incompleteTheme);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required colors'))).toBe(true);
    });

    it('should report invalid hex colors', () => {
      const invalidTheme = createValidThemeDefinition();
      invalidTheme.base = 'not-a-color';
      const result = validateThemeDefinition(invalidTheme);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes("Invalid hex color for 'base'"))).toBe(true);
    });

    it('should report unexpected properties', () => {
      const extraTheme = createValidThemeDefinition();
      (extraTheme as Record<string, string>).extraColor = '#AABBCC';
      const result = validateThemeDefinition(extraTheme);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Unexpected properties'))).toBe(true);
    });
  });

  describe('isThemeDefinition', () => {
    it('should return true for valid theme definitions', () => {
      const validTheme = createValidThemeDefinition();
      expect(isThemeDefinition(validTheme)).toBe(true);
    });

    it('should return false for invalid theme definitions', () => {
      expect(isThemeDefinition({})).toBe(false);
      expect(isThemeDefinition(null)).toBe(false);
      expect(isThemeDefinition({ base: 'invalid' })).toBe(false);
    });
  });

  describe('normalizeHexColor', () => {
    it('should expand 3-char hex to 6-char uppercase', () => {
      expect(normalizeHexColor('#ABC')).toBe('#AABBCC');
      expect(normalizeHexColor('#abc')).toBe('#AABBCC');
      expect(normalizeHexColor('#123')).toBe('#112233');
    });

    it('should uppercase 6-char hex colors', () => {
      expect(normalizeHexColor('#aabbcc')).toBe('#AABBCC');
      expect(normalizeHexColor('#AABBCC')).toBe('#AABBCC');
    });

    it('should handle 8-char hex colors', () => {
      expect(normalizeHexColor('#aabbccdd')).toBe('#AABBCCDD');
    });

    it('should return invalid colors unchanged', () => {
      expect(normalizeHexColor('not-a-color')).toBe('not-a-color');
      expect(normalizeHexColor('')).toBe('');
    });
  });

  describe('normalizeThemeDefinition', () => {
    it('should normalize all colors in a theme definition', () => {
      const theme = createValidThemeDefinition();
      theme.base = '#abc';
      theme.text = '#def';

      const normalized = normalizeThemeDefinition(theme as any);
      expect(normalized.base).toBe('#AABBCC');
      expect(normalized.text).toBe('#DDEEFF');
    });
  });

  describe('REQUIRED_THEME_COLORS', () => {
    it('should contain all 26 required colors', () => {
      expect(REQUIRED_THEME_COLORS).toHaveLength(26);
    });

    it('should include key color categories', () => {
      expect(REQUIRED_THEME_COLORS).toContain('base');
      expect(REQUIRED_THEME_COLORS).toContain('text');
      expect(REQUIRED_THEME_COLORS).toContain('blue');
      expect(REQUIRED_THEME_COLORS).toContain('red');
      expect(REQUIRED_THEME_COLORS).toContain('green');
    });
  });
});
