/**
 * Accessibility Contrast Checker
 *
 * Implements WCAG 2.1 contrast ratio calculations to ensure themes meet
 * accessibility standards for readability.
 *
 * WCAG Requirements:
 * - AA Normal Text: 4.5:1
 * - AA Large Text: 3:1
 * - AAA Normal Text: 7:1
 * - AAA Large Text: 4.5:1
 */

import type { ThemeDefinition } from '../services/database.js';
import { isValidHexColor } from './themeValidation.js';

/**
 * RGB color representation
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * WCAG compliance level
 */
export type WCAGLevel = 'AA' | 'AAA';

/**
 * Text size category
 */
export type TextSize = 'normal' | 'large';

/**
 * Contrast check result
 */
export interface ContrastResult {
  ratio: number;
  passesAA: boolean;
  passesAAA: boolean;
  passesAALarge: boolean;
  passesAAALarge: boolean;
}

/**
 * Theme accessibility report
 */
export interface AccessibilityReport {
  isAccessible: boolean;
  warnings: string[];
  criticalIssues: string[];
  textOnBaseContrast: ContrastResult;
  textOnSurfaceContrast: ContrastResult;
  recommendations: string[];
}

/**
 * Converts a hex color to RGB
 *
 * @param hex - Hex color string (#RRGGBB or #RGB)
 * @returns RGB object with r, g, b values (0-255)
 */
export function hexToRgb(hex: string): RGB {
  if (!isValidHexColor(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  let cleanHex = hex.replace('#', '');

  // Expand 3-char format to 6-char
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }

  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);

  return { r, g, b };
}

/**
 * Converts an RGB value (0-255) to sRGB (0-1)
 * and applies gamma correction
 *
 * @param value - RGB value (0-255)
 * @returns Linearized sRGB value (0-1)
 */
function sRGBtoLinear(value: number): number {
  const normalized = value / 255;

  if (normalized <= 0.03928) {
    return normalized / 12.92;
  }

  return Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/**
 * Calculates the relative luminance of a color
 * per WCAG 2.1 specification
 *
 * @param rgb - RGB color object
 * @returns Relative luminance (0-1)
 */
export function getRelativeLuminance(rgb: RGB): number {
  const r = sRGBtoLinear(rgb.r);
  const g = sRGBtoLinear(rgb.g);
  const b = sRGBtoLinear(rgb.b);

  // ITU-R BT.709 coefficients
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculates the contrast ratio between two colors
 * per WCAG 2.1 specification
 *
 * @param color1 - First hex color
 * @param color2 - Second hex color
 * @returns Contrast ratio (1-21)
 */
export function getContrastRatio(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  const l1 = getRelativeLuminance(rgb1);
  const l2 = getRelativeLuminance(rgb2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks if a contrast ratio meets WCAG requirements
 *
 * @param ratio - Contrast ratio to check
 * @returns ContrastResult with WCAG compliance info
 */
export function checkContrast(ratio: number): ContrastResult {
  return {
    ratio,
    passesAA: ratio >= 4.5,          // AA normal text
    passesAAA: ratio >= 7.0,          // AAA normal text
    passesAALarge: ratio >= 3.0,      // AA large text (18pt+ or 14pt+ bold)
    passesAAALarge: ratio >= 4.5      // AAA large text
  };
}

/**
 * Checks contrast between two colors with WCAG validation
 *
 * @param foreground - Foreground hex color
 * @param background - Background hex color
 * @returns ContrastResult with compliance info
 */
export function checkColorContrast(
  foreground: string,
  background: string
): ContrastResult {
  const ratio = getContrastRatio(foreground, background);
  return checkContrast(ratio);
}

/**
 * Validates a theme for accessibility compliance
 * Checks critical color combinations for readability
 *
 * @param theme - Theme definition to validate
 * @returns AccessibilityReport with warnings and recommendations
 */
export function validateThemeAccessibility(
  theme: ThemeDefinition
): AccessibilityReport {
  const warnings: string[] = [];
  const criticalIssues: string[] = [];
  const recommendations: string[] = [];

  // Check text on base background
  const textOnBase = checkColorContrast(theme.text, theme.base);

  if (!textOnBase.passesAA) {
    criticalIssues.push(
      `Text on base background has insufficient contrast (${textOnBase.ratio.toFixed(2)}:1). ` +
      `Minimum required: 4.5:1 for AA compliance.`
    );
  } else if (!textOnBase.passesAAA) {
    warnings.push(
      `Text on base background passes AA (${textOnBase.ratio.toFixed(2)}:1) ` +
      `but not AAA (7:1 required).`
    );
  }

  // Check text on surface0 (commonly used for cards/panels)
  const textOnSurface = checkColorContrast(theme.text, theme.surface0);

  if (!textOnSurface.passesAA) {
    criticalIssues.push(
      `Text on surface background has insufficient contrast (${textOnSurface.ratio.toFixed(2)}:1). ` +
      `Minimum required: 4.5:1 for AA compliance.`
    );
  } else if (!textOnSurface.passesAAA) {
    warnings.push(
      `Text on surface background passes AA (${textOnSurface.ratio.toFixed(2)}:1) ` +
      `but not AAA (7:1 required).`
    );
  }

  // Check subtext on base (secondary text)
  const subtextOnBase = checkColorContrast(theme.subtext0, theme.base);

  if (!subtextOnBase.passesAA) {
    warnings.push(
      `Subtext on base background has low contrast (${subtextOnBase.ratio.toFixed(2)}:1). ` +
      `Consider using a darker/lighter shade for better readability.`
    );
  }

  // Check accent colors on base for interactive elements
  const accentColors = ['blue', 'green', 'yellow', 'red'] as const;

  for (const color of accentColors) {
    const contrast = checkColorContrast(theme[color], theme.base);

    if (!contrast.passesAALarge) {
      warnings.push(
        `Accent color '${color}' may be hard to see on base background ` +
        `(${contrast.ratio.toFixed(2)}:1). Consider adjusting brightness.`
      );
    }
  }

  // Provide recommendations
  if (criticalIssues.length === 0 && warnings.length === 0) {
    recommendations.push('Theme meets WCAG AA standards for all tested color combinations.');
  }

  if (textOnBase.passesAAA && textOnSurface.passesAAA) {
    recommendations.push('Theme meets WCAG AAA standards for primary text - excellent accessibility!');
  }

  if (criticalIssues.length > 0) {
    recommendations.push(
      'Increase contrast between text and background colors. ' +
      'Try making backgrounds darker or text lighter (or vice versa).'
    );
  }

  if (warnings.length > 0 && criticalIssues.length === 0) {
    recommendations.push(
      'Theme is usable but could be improved for users with visual impairments. ' +
      'Consider adjusting color values for AAA compliance.'
    );
  }

  return {
    isAccessible: criticalIssues.length === 0,
    warnings,
    criticalIssues,
    textOnBaseContrast: textOnBase,
    textOnSurfaceContrast: textOnSurface,
    recommendations
  };
}

/**
 * Suggests color adjustments to improve contrast
 * Returns a lighter or darker version of the color
 *
 * @param hex - Hex color to adjust
 * @param targetLuminance - Target relative luminance (0-1)
 * @returns Adjusted hex color
 */
export function suggestContrastImprovement(
  hex: string,
  targetLuminance: number
): string {
  const rgb = hexToRgb(hex);
  const currentLuminance = getRelativeLuminance(rgb);

  // Determine if we need to lighten or darken
  const shouldLighten = targetLuminance > currentLuminance;
  const factor = shouldLighten ? 1.2 : 0.8;

  // Adjust RGB values
  const adjusted: RGB = {
    r: Math.min(255, Math.max(0, Math.round(rgb.r * factor))),
    g: Math.min(255, Math.max(0, Math.round(rgb.g * factor))),
    b: Math.min(255, Math.max(0, Math.round(rgb.b * factor)))
  };

  // Convert back to hex
  const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(adjusted.r)}${toHex(adjusted.g)}${toHex(adjusted.b)}`;
}

/**
 * Formats a contrast ratio for display
 *
 * @param ratio - Contrast ratio to format
 * @returns Formatted string (e.g., "4.5:1")
 */
export function formatContrastRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}
