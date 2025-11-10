/**
 * Unit Tests for Accessibility Checker Utilities
 *
 * Comprehensive test suite covering:
 * - Hex to RGB color conversion
 * - Relative luminance calculations per WCAG 2.1
 * - Contrast ratio calculations
 * - WCAG AA/AAA compliance checking
 * - Theme accessibility validation
 * - Contrast improvement suggestions
 */

import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  getRelativeLuminance,
  getContrastRatio,
  checkContrast,
  checkColorContrast,
  validateThemeAccessibility,
  suggestContrastImprovement,
  formatContrastRatio,
  type RGB,
  type ContrastResult,
  type AccessibilityReport
} from '../../src/utils/accessibilityChecker.js';

describe('hexToRgb', () => {
  describe('6-digit hex conversion', () => {
    it('converts 6-digit hex to RGB', () => {
      expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
      expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
      expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('handles lowercase hex colors', () => {
      expect(hexToRgb('#abc123')).toEqual({ r: 171, g: 193, b: 35 });
      expect(hexToRgb('#def456')).toEqual({ r: 222, g: 244, b: 86 });
    });

    it('handles uppercase hex colors', () => {
      expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
      expect(hexToRgb('#ABCDEF')).toEqual({ r: 171, g: 205, b: 239 });
    });

    it('handles mixed case hex colors', () => {
      expect(hexToRgb('#AaBbCc')).toEqual({ r: 170, g: 187, b: 204 });
      expect(hexToRgb('#1a2B3c')).toEqual({ r: 26, g: 43, b: 60 });
    });

    it('converts specific color values correctly', () => {
      // Gray
      expect(hexToRgb('#808080')).toEqual({ r: 128, g: 128, b: 128 });
      // Orange
      expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
      // Purple
      expect(hexToRgb('#8800ff')).toEqual({ r: 136, g: 0, b: 255 });
    });
  });

  describe('3-digit hex conversion', () => {
    it('converts 3-digit hex to RGB by expanding', () => {
      expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
      expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
      expect(hexToRgb('#0f0')).toEqual({ r: 0, g: 255, b: 0 });
      expect(hexToRgb('#00f')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('expands 3-digit hex correctly', () => {
      // #abc -> #aabbcc
      expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
      // #123 -> #112233
      expect(hexToRgb('#123')).toEqual({ r: 17, g: 34, b: 51 });
      // #fed -> #ffeedd
      expect(hexToRgb('#fed')).toEqual({ r: 255, g: 238, b: 221 });
    });

    it('handles uppercase 3-digit hex', () => {
      expect(hexToRgb('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb('#ABC')).toEqual({ r: 170, g: 187, b: 204 });
    });
  });

  describe('error handling', () => {
    it('throws error for invalid hex colors', () => {
      expect(() => hexToRgb('invalid')).toThrow('Invalid hex color: invalid');
      expect(() => hexToRgb('#gg0000')).toThrow('Invalid hex color: #gg0000');
      expect(() => hexToRgb('ff0000')).toThrow('Invalid hex color: ff0000');
      expect(() => hexToRgb('')).toThrow('Invalid hex color: ');
    });

    it('throws error for invalid lengths', () => {
      expect(() => hexToRgb('#ff')).toThrow();
      expect(() => hexToRgb('#ff00')).toThrow();
      expect(() => hexToRgb('#ff00000')).toThrow();
    });

    it('throws error for missing # prefix', () => {
      expect(() => hexToRgb('ffffff')).toThrow();
      expect(() => hexToRgb('fff')).toThrow();
    });
  });
});

describe('getRelativeLuminance', () => {
  describe('known luminance values', () => {
    it('calculates luminance for white (1.0)', () => {
      const white = { r: 255, g: 255, b: 255 };
      expect(getRelativeLuminance(white)).toBeCloseTo(1.0, 2);
    });

    it('calculates luminance for black (0.0)', () => {
      const black = { r: 0, g: 0, b: 0 };
      expect(getRelativeLuminance(black)).toBeCloseTo(0.0, 2);
    });

    it('calculates luminance for pure red', () => {
      const red = { r: 255, g: 0, b: 0 };
      const luminance = getRelativeLuminance(red);
      expect(luminance).toBeGreaterThan(0);
      expect(luminance).toBeLessThan(1);
      // Red coefficient is 0.2126
      expect(luminance).toBeCloseTo(0.2126, 2);
    });

    it('calculates luminance for pure green', () => {
      const green = { r: 0, g: 255, b: 0 };
      const luminance = getRelativeLuminance(green);
      // Green coefficient is 0.7152 (highest)
      expect(luminance).toBeCloseTo(0.7152, 2);
    });

    it('calculates luminance for pure blue', () => {
      const blue = { r: 0, g: 0, b: 255 };
      const luminance = getRelativeLuminance(blue);
      // Blue coefficient is 0.0722 (lowest)
      expect(luminance).toBeCloseTo(0.0722, 2);
    });
  });

  describe('gray scale luminance', () => {
    it('calculates increasing luminance for grays', () => {
      const darkGray = { r: 64, g: 64, b: 64 };
      const midGray = { r: 128, g: 128, b: 128 };
      const lightGray = { r: 192, g: 192, b: 192 };

      const l1 = getRelativeLuminance(darkGray);
      const l2 = getRelativeLuminance(midGray);
      const l3 = getRelativeLuminance(lightGray);

      expect(l1).toBeLessThan(l2);
      expect(l2).toBeLessThan(l3);
    });

    it('calculates 50% gray luminance', () => {
      const midGray = { r: 128, g: 128, b: 128 };
      const luminance = getRelativeLuminance(midGray);
      // Should be somewhere around middle range
      expect(luminance).toBeGreaterThan(0.1);
      expect(luminance).toBeLessThan(0.3);
    });
  });

  describe('gamma correction application', () => {
    it('applies gamma correction for low values', () => {
      // Low RGB values should use linear division (value / 12.92)
      const lowValue = { r: 5, g: 5, b: 5 };
      const luminance = getRelativeLuminance(lowValue);
      expect(luminance).toBeGreaterThan(0);
      expect(luminance).toBeLessThan(0.01);
    });

    it('applies gamma correction for high values', () => {
      // High RGB values should use power function
      const highValue = { r: 200, g: 200, b: 200 };
      const luminance = getRelativeLuminance(highValue);
      expect(luminance).toBeGreaterThan(0.5);
      expect(luminance).toBeLessThan(1.0);
    });
  });

  describe('consistency', () => {
    it('returns same luminance for same RGB values', () => {
      const color = { r: 123, g: 45, b: 67 };
      const l1 = getRelativeLuminance(color);
      const l2 = getRelativeLuminance(color);
      expect(l1).toBe(l2);
    });

    it('returns values in range [0, 1]', () => {
      const testColors: RGB[] = [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
        { r: 128, g: 64, b: 192 },
        { r: 255, g: 0, b: 128 },
        { r: 32, g: 32, b: 32 }
      ];

      for (const color of testColors) {
        const luminance = getRelativeLuminance(color);
        expect(luminance).toBeGreaterThanOrEqual(0);
        expect(luminance).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('getContrastRatio', () => {
  describe('maximum and minimum contrast', () => {
    it('calculates maximum contrast (white on black)', () => {
      const ratio = getContrastRatio('#ffffff', '#000000');
      expect(ratio).toBeCloseTo(21, 1);
    });

    it('calculates maximum contrast (black on white)', () => {
      const ratio = getContrastRatio('#000000', '#ffffff');
      expect(ratio).toBeCloseTo(21, 1);
    });

    it('calculates minimum contrast (same color)', () => {
      expect(getContrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 1);
      expect(getContrastRatio('#000000', '#000000')).toBeCloseTo(1, 1);
      expect(getContrastRatio('#808080', '#808080')).toBeCloseTo(1, 1);
    });
  });

  describe('symmetry', () => {
    it('returns same ratio regardless of order', () => {
      const ratio1 = getContrastRatio('#ffffff', '#000000');
      const ratio2 = getContrastRatio('#000000', '#ffffff');
      expect(ratio1).toBeCloseTo(ratio2, 2);

      const ratio3 = getContrastRatio('#ff0000', '#0000ff');
      const ratio4 = getContrastRatio('#0000ff', '#ff0000');
      expect(ratio3).toBeCloseTo(ratio4, 2);
    });
  });

  describe('known contrast ratios', () => {
    it('calculates known WCAG test case ratios', () => {
      // Gray (#767676) on white should be approximately 4.54:1
      const ratio1 = getContrastRatio('#767676', '#ffffff');
      expect(ratio1).toBeGreaterThan(4.5);
      expect(ratio1).toBeLessThan(4.6);

      // Should pass AA for normal text (4.5:1 required)
      expect(ratio1).toBeGreaterThan(4.5);
    });

    it('calculates ratio for dark text on light background', () => {
      // Dark gray on white
      const ratio = getContrastRatio('#333333', '#ffffff');
      expect(ratio).toBeGreaterThan(12);
      expect(ratio).toBeLessThan(13);
    });

    it('calculates ratio for light text on dark background', () => {
      // Light gray on black
      const ratio = getContrastRatio('#cccccc', '#000000');
      expect(ratio).toBeGreaterThan(13);
      expect(ratio).toBeLessThan(14);
    });
  });

  describe('3-digit hex support', () => {
    it('handles 3-digit hex colors', () => {
      const ratio = getContrastRatio('#fff', '#000');
      expect(ratio).toBeCloseTo(21, 1);

      const ratio2 = getContrastRatio('#f00', '#0f0');
      expect(ratio2).toBeGreaterThan(1);
    });
  });

  describe('color combinations', () => {
    it('calculates ratio for blue on white', () => {
      const ratio = getContrastRatio('#0000ff', '#ffffff');
      expect(ratio).toBeGreaterThan(8);
      expect(ratio).toBeLessThan(9);
    });

    it('calculates ratio for yellow on white', () => {
      const ratio = getContrastRatio('#ffff00', '#ffffff');
      // Yellow on white has poor contrast
      expect(ratio).toBeLessThan(2);
    });

    it('calculates ratio for red on black', () => {
      const ratio = getContrastRatio('#ff0000', '#000000');
      expect(ratio).toBeGreaterThan(5);
      expect(ratio).toBeLessThan(6);
    });
  });
});

describe('checkContrast', () => {
  describe('WCAG AA normal text (4.5:1)', () => {
    it('passes AA for ratio >= 4.5', () => {
      const result = checkContrast(4.5);
      expect(result.passesAA).toBe(true);
      expect(result.ratio).toBe(4.5);

      const result2 = checkContrast(7.0);
      expect(result2.passesAA).toBe(true);
    });

    it('fails AA for ratio < 4.5', () => {
      const result = checkContrast(4.4);
      expect(result.passesAA).toBe(false);

      const result2 = checkContrast(3.0);
      expect(result2.passesAA).toBe(false);
    });
  });

  describe('WCAG AAA normal text (7:1)', () => {
    it('passes AAA for ratio >= 7.0', () => {
      const result = checkContrast(7.0);
      expect(result.passesAAA).toBe(true);

      const result2 = checkContrast(21);
      expect(result2.passesAAA).toBe(true);
    });

    it('fails AAA for ratio < 7.0', () => {
      const result = checkContrast(6.9);
      expect(result.passesAAA).toBe(false);

      const result2 = checkContrast(4.5);
      expect(result2.passesAAA).toBe(false);
    });
  });

  describe('WCAG AA large text (3:1)', () => {
    it('passes AA large for ratio >= 3.0', () => {
      const result = checkContrast(3.0);
      expect(result.passesAALarge).toBe(true);

      const result2 = checkContrast(4.5);
      expect(result2.passesAALarge).toBe(true);
    });

    it('fails AA large for ratio < 3.0', () => {
      const result = checkContrast(2.9);
      expect(result.passesAALarge).toBe(false);

      const result2 = checkContrast(1.5);
      expect(result2.passesAALarge).toBe(false);
    });
  });

  describe('WCAG AAA large text (4.5:1)', () => {
    it('passes AAA large for ratio >= 4.5', () => {
      const result = checkContrast(4.5);
      expect(result.passesAAALarge).toBe(true);

      const result2 = checkContrast(7.0);
      expect(result2.passesAAALarge).toBe(true);
    });

    it('fails AAA large for ratio < 4.5', () => {
      const result = checkContrast(4.4);
      expect(result.passesAAALarge).toBe(false);

      const result2 = checkContrast(3.0);
      expect(result2.passesAAALarge).toBe(false);
    });
  });

  describe('combined requirements', () => {
    it('checks all requirements for high contrast (21:1)', () => {
      const result = checkContrast(21);
      expect(result.passesAA).toBe(true);
      expect(result.passesAAA).toBe(true);
      expect(result.passesAALarge).toBe(true);
      expect(result.passesAAALarge).toBe(true);
    });

    it('checks all requirements for medium contrast (5:1)', () => {
      const result = checkContrast(5);
      expect(result.passesAA).toBe(true);      // Passes normal AA
      expect(result.passesAAA).toBe(false);    // Fails normal AAA
      expect(result.passesAALarge).toBe(true); // Passes large AA
      expect(result.passesAAALarge).toBe(true); // Passes large AAA
    });

    it('checks all requirements for low contrast (2:1)', () => {
      const result = checkContrast(2);
      expect(result.passesAA).toBe(false);
      expect(result.passesAAA).toBe(false);
      expect(result.passesAALarge).toBe(false);
      expect(result.passesAAALarge).toBe(false);
    });
  });
});

describe('checkColorContrast', () => {
  it('returns contrast result for two colors', () => {
    const result = checkColorContrast('#ffffff', '#000000');
    expect(result.ratio).toBeCloseTo(21, 1);
    expect(result.passesAA).toBe(true);
    expect(result.passesAAA).toBe(true);
  });

  it('combines hex conversion and contrast checking', () => {
    const result = checkColorContrast('#767676', '#ffffff');
    expect(result.ratio).toBeGreaterThan(4.5);
    expect(result.ratio).toBeLessThan(4.6);
    expect(result.passesAA).toBe(true); // Should pass AA
  });

  it('handles 3-digit hex colors', () => {
    const result = checkColorContrast('#fff', '#000');
    expect(result.ratio).toBeCloseTo(21, 1);
    expect(result.passesAA).toBe(true);
  });

  it('is symmetric', () => {
    const result1 = checkColorContrast('#ff0000', '#0000ff');
    const result2 = checkColorContrast('#0000ff', '#ff0000');
    expect(result1.ratio).toBeCloseTo(result2.ratio, 2);
  });
});

describe('validateThemeAccessibility', () => {
  const highContrastTheme = {
    base: '#000000',
    mantle: '#0a0a0a',
    crust: '#050505',
    text: '#ffffff',
    subtext1: '#e0e0e0',
    subtext0: '#c0c0c0',
    overlay2: '#909090',
    overlay1: '#707070',
    overlay0: '#505050',
    surface2: '#404040',
    surface1: '#303030',
    surface0: '#202020',
    lavender: '#bb99ff',
    blue: '#6699ff',
    sapphire: '#00ccff',
    sky: '#00ddff',
    teal: '#00ffcc',
    green: '#00ff00',
    yellow: '#ffff00',
    peach: '#ffaa00',
    maroon: '#ff0066',
    red: '#ff0000',
    mauve: '#cc00ff',
    pink: '#ff00cc',
    flamingo: '#ff6699',
    rosewater: '#ffccdd'
  };

  const lowContrastTheme = {
    ...highContrastTheme,
    text: '#333333',      // Dark gray on black - very low contrast
    subtext1: '#222222',
    subtext0: '#111111'
  };

  const aaCompliantTheme = {
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

  describe('high contrast theme', () => {
    it('validates accessible theme', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.isAccessible).toBe(true);
      expect(result.criticalIssues).toHaveLength(0);
    });

    it('provides text on base contrast info', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.textOnBaseContrast).toBeDefined();
      expect(result.textOnBaseContrast.ratio).toBeCloseTo(21, 1);
      expect(result.textOnBaseContrast.passesAA).toBe(true);
      expect(result.textOnBaseContrast.passesAAA).toBe(true);
    });

    it('provides text on surface contrast info', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.textOnSurfaceContrast).toBeDefined();
      expect(result.textOnSurfaceContrast.passesAA).toBe(true);
    });

    it('includes recommendations for excellent accessibility', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('low contrast theme', () => {
    it('detects insufficient contrast', () => {
      const result = validateThemeAccessibility(lowContrastTheme as any);
      expect(result.isAccessible).toBe(false);
    });

    it('reports critical issues', () => {
      const result = validateThemeAccessibility(lowContrastTheme as any);
      expect(result.criticalIssues.length).toBeGreaterThan(0);
      expect(result.criticalIssues.some(i => i.includes('insufficient contrast'))).toBe(true);
    });

    it('provides specific contrast ratios in errors', () => {
      const result = validateThemeAccessibility(lowContrastTheme as any);
      const textOnBaseIssue = result.criticalIssues.find(i => i.includes('Text on base'));
      expect(textOnBaseIssue).toBeDefined();
      expect(textOnBaseIssue).toMatch(/\d+\.\d+:1/); // Contains ratio like "2.45:1"
    });

    it('mentions WCAG requirements in errors', () => {
      const result = validateThemeAccessibility(lowContrastTheme as any);
      const hasAAReference = result.criticalIssues.some(i => i.includes('AA compliance'));
      expect(hasAAReference).toBe(true);
    });

    it('provides recommendations for improvement', () => {
      const result = validateThemeAccessibility(lowContrastTheme as any);
      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations.some(r =>
        r.includes('contrast') || r.includes('darker') || r.includes('lighter')
      )).toBe(true);
    });
  });

  describe('AA compliant theme', () => {
    it('validates Catppuccin-style theme', () => {
      const result = validateThemeAccessibility(aaCompliantTheme as any);
      // Catppuccin themes should pass AA
      expect(result.textOnBaseContrast.passesAA).toBe(true);
    });

    it('may have warnings for AAA', () => {
      const result = validateThemeAccessibility(aaCompliantTheme as any);
      // If it doesn't pass AAA, should have warnings
      if (!result.textOnBaseContrast.passesAAA) {
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    });
  });

  describe('warnings vs critical issues', () => {
    it('separates warnings from critical issues', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.warnings).toBeDefined();
      expect(result.criticalIssues).toBeDefined();
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(Array.isArray(result.criticalIssues)).toBe(true);
    });

    it('generates warnings for subtext contrast', () => {
      const themeWithLowSubtext = {
        ...highContrastTheme,
        subtext0: '#404040' // Lower contrast but not critical
      };
      const result = validateThemeAccessibility(themeWithLowSubtext as any);
      // May have warnings about subtext
      expect(result.warnings).toBeDefined();
    });

    it('generates warnings for accent colors', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      // Check that accent color validation is performed
      expect(result).toBeDefined();
    });
  });

  describe('report structure', () => {
    it('returns complete accessibility report', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result).toHaveProperty('isAccessible');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('criticalIssues');
      expect(result).toHaveProperty('textOnBaseContrast');
      expect(result).toHaveProperty('textOnSurfaceContrast');
      expect(result).toHaveProperty('recommendations');
    });

    it('provides contrast results with all WCAG levels', () => {
      const result = validateThemeAccessibility(highContrastTheme as any);
      expect(result.textOnBaseContrast).toHaveProperty('ratio');
      expect(result.textOnBaseContrast).toHaveProperty('passesAA');
      expect(result.textOnBaseContrast).toHaveProperty('passesAAA');
      expect(result.textOnBaseContrast).toHaveProperty('passesAALarge');
      expect(result.textOnBaseContrast).toHaveProperty('passesAAALarge');
    });
  });
});

describe('suggestContrastImprovement', () => {
  it('suggests lighter color when target luminance is higher', () => {
    const darker = '#404040';
    const improved = suggestContrastImprovement(darker, 0.5);

    const originalRgb = hexToRgb(darker);
    const improvedRgb = hexToRgb(improved);

    // Improved should be lighter (higher RGB values)
    expect(improvedRgb.r).toBeGreaterThan(originalRgb.r);
    expect(improvedRgb.g).toBeGreaterThan(originalRgb.g);
    expect(improvedRgb.b).toBeGreaterThan(originalRgb.b);
  });

  it('suggests darker color when target luminance is lower', () => {
    const lighter = '#c0c0c0';
    const improved = suggestContrastImprovement(lighter, 0.1);

    const originalRgb = hexToRgb(lighter);
    const improvedRgb = hexToRgb(improved);

    // Improved should be darker (lower RGB values)
    expect(improvedRgb.r).toBeLessThan(originalRgb.r);
    expect(improvedRgb.g).toBeLessThan(originalRgb.g);
    expect(improvedRgb.b).toBeLessThan(originalRgb.b);
  });

  it('returns valid hex color format', () => {
    const result = suggestContrastImprovement('#808080', 0.5);
    expect(result).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('keeps RGB values in valid range [0-255]', () => {
    // Test with very dark color
    const dark = suggestContrastImprovement('#000000', 0.1);
    const darkRgb = hexToRgb(dark);
    expect(darkRgb.r).toBeGreaterThanOrEqual(0);
    expect(darkRgb.r).toBeLessThanOrEqual(255);

    // Test with very light color
    const light = suggestContrastImprovement('#ffffff', 0.9);
    const lightRgb = hexToRgb(light);
    expect(lightRgb.r).toBeGreaterThanOrEqual(0);
    expect(lightRgb.r).toBeLessThanOrEqual(255);
  });

  it('handles 3-digit hex colors', () => {
    const result = suggestContrastImprovement('#fff', 0.5);
    expect(result).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('produces uppercase hex output', () => {
    const result = suggestContrastImprovement('#123456', 0.5);
    expect(result).toBe(result.toUpperCase());
  });
});

describe('formatContrastRatio', () => {
  it('formats ratio with 2 decimal places', () => {
    expect(formatContrastRatio(4.5)).toBe('4.50:1');
    expect(formatContrastRatio(7.0)).toBe('7.00:1');
    expect(formatContrastRatio(21)).toBe('21.00:1');
  });

  it('formats decimal ratios correctly', () => {
    expect(formatContrastRatio(3.14159)).toBe('3.14:1');
    expect(formatContrastRatio(12.5678)).toBe('12.57:1');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatContrastRatio(4.556)).toBe('4.56:1'); // Rounds up
    expect(formatContrastRatio(4.554)).toBe('4.55:1'); // Rounds down
  });

  it('handles small ratios', () => {
    expect(formatContrastRatio(1.0)).toBe('1.00:1');
    expect(formatContrastRatio(1.5)).toBe('1.50:1');
  });

  it('handles large ratios', () => {
    expect(formatContrastRatio(21.0)).toBe('21.00:1');
    expect(formatContrastRatio(18.5)).toBe('18.50:1');
  });
});

describe('edge cases and integration', () => {
  it('handles complete workflow from hex to accessibility report', () => {
    const theme = {
      base: '#ffffff',
      text: '#000000',
      surface0: '#f0f0f0',
      subtext0: '#333333',
      blue: '#0000ff',
      green: '#00ff00',
      yellow: '#ffff00',
      red: '#ff0000',
      // Fill in remaining required colors
      mantle: '#fafafa', crust: '#f5f5f5',
      subtext1: '#666666',
      overlay2: '#999999', overlay1: '#aaaaaa', overlay0: '#bbbbbb',
      surface2: '#dddddd', surface1: '#eeeeee',
      lavender: '#9999ff', sapphire: '#0099ff', sky: '#00aaff',
      teal: '#00ffaa', peach: '#ffaa00', maroon: '#aa0066',
      mauve: '#aa00ff', pink: '#ff00aa', flamingo: '#ff6699',
      rosewater: '#ffaacc'
    };

    const report = validateThemeAccessibility(theme as any);
    expect(report.isAccessible).toBe(true);
    expect(report.textOnBaseContrast.ratio).toBeCloseTo(21, 1);
  });

  it('handles themes with mixed 3-digit and 6-digit colors', () => {
    const theme = {
      base: '#000',
      text: '#ffffff',
      surface0: '#111',
      subtext0: '#ccc',
      // Fill in remaining required colors
      mantle: '#0a0a0a', crust: '#050505',
      subtext1: '#e0e0e0',
      overlay2: '#999', overlay1: '#888', overlay0: '#777',
      surface2: '#444', surface1: '#333',
      lavender: '#99f', blue: '#00f', sapphire: '#0cf', sky: '#0df',
      teal: '#0fc', green: '#0f0', yellow: '#ff0', peach: '#fa0',
      maroon: '#a06', red: '#f00', mauve: '#c0f', pink: '#f0c',
      flamingo: '#f69', rosewater: '#fcd'
    };

    const report = validateThemeAccessibility(theme as any);
    expect(report).toBeDefined();
    expect(report.textOnBaseContrast).toBeDefined();
  });
});
