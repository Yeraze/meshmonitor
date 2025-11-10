/**
 * Theme Validation Utilities
 *
 * Provides comprehensive validation for custom theme creation including:
 * - Hex color format validation
 * - Theme slug validation (custom- prefix requirement)
 * - Theme name validation (length, allowed characters)
 * - Complete theme definition validation
 */

import type { ThemeDefinition } from '../services/database.js';

/**
 * Validates a hex color string
 * Accepts: #RGB, #RRGGBB, #RRGGBBAA formats
 *
 * @param color - The color string to validate
 * @returns true if valid hex color, false otherwise
 */
export function isValidHexColor(color: string): boolean {
  if (typeof color !== 'string') {
    return false;
  }

  // Must start with #
  if (!color.startsWith('#')) {
    return false;
  }

  const hex = color.substring(1);

  // Valid lengths: 3 (RGB), 6 (RRGGBB), 8 (RRGGBBAA)
  if (![3, 6, 8].includes(hex.length)) {
    return false;
  }

  // All characters must be valid hex
  return /^[0-9A-Fa-f]+$/.test(hex);
}

/**
 * Validates a theme slug
 * Must:
 * - Start with "custom-" prefix
 * - Contain only lowercase letters, numbers, and hyphens
 * - Be between 8 and 50 characters total
 *
 * @param slug - The slug to validate
 * @returns true if valid slug, false otherwise
 */
export function isValidThemeSlug(slug: string): boolean {
  if (typeof slug !== 'string') {
    return false;
  }

  // Must start with "custom-"
  if (!slug.startsWith('custom-')) {
    return false;
  }

  // Length check: minimum "custom-x" (8 chars), maximum 50 chars
  if (slug.length < 8 || slug.length > 50) {
    return false;
  }

  // Only lowercase alphanumeric and hyphens allowed
  return /^custom-[a-z0-9-]+$/.test(slug);
}

/**
 * Validates a theme name
 * Must be between 1 and 50 characters
 *
 * @param name - The theme name to validate
 * @returns true if valid name, false otherwise
 */
export function isValidThemeName(name: string): boolean {
  if (typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 50;
}

/**
 * Generates a slug from a theme name
 * Converts to lowercase, replaces spaces/special chars with hyphens
 * Adds "custom-" prefix
 *
 * @param name - The theme name
 * @returns A valid slug string
 */
export function generateThemeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')         // Replace spaces with hyphens
    .replace(/-+/g, '-')          // Replace multiple hyphens with single
    .replace(/^-|-$/g, '');       // Remove leading/trailing hyphens

  // Ensure it starts with custom-
  const prefixed = slug.startsWith('custom-') ? slug : `custom-${slug}`;

  // Ensure it's not too long
  return prefixed.substring(0, 50);
}

/**
 * All required color keys for a theme definition
 */
export const REQUIRED_THEME_COLORS = [
  'base', 'mantle', 'crust',
  'text', 'subtext1', 'subtext0',
  'overlay2', 'overlay1', 'overlay0',
  'surface2', 'surface1', 'surface0',
  'lavender', 'blue', 'sapphire',
  'sky', 'teal', 'green',
  'yellow', 'peach', 'maroon',
  'red', 'mauve', 'pink',
  'flamingo', 'rosewater'
] as const;

/**
 * Validates a complete theme definition
 * Ensures all required color keys are present and valid hex colors
 *
 * @param definition - The theme definition to validate
 * @returns Object with isValid boolean and errors array
 */
export function validateThemeDefinition(definition: any): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check if definition is an object
  if (!definition || typeof definition !== 'object') {
    return {
      isValid: false,
      errors: ['Theme definition must be an object']
    };
  }

  // Check for required colors
  const missingColors = REQUIRED_THEME_COLORS.filter(
    color => !(color in definition)
  );

  if (missingColors.length > 0) {
    errors.push(`Missing required colors: ${missingColors.join(', ')}`);
  }

  // Validate each color value
  for (const color of REQUIRED_THEME_COLORS) {
    const value = definition[color];

    if (value !== undefined && !isValidHexColor(value)) {
      errors.push(`Invalid hex color for '${color}': ${value}`);
    }
  }

  // Check for unexpected properties
  const extraKeys = Object.keys(definition).filter(
    key => !REQUIRED_THEME_COLORS.includes(key as any)
  );

  if (extraKeys.length > 0) {
    errors.push(`Unexpected properties: ${extraKeys.join(', ')}`);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Type guard for ThemeDefinition
 *
 * @param definition - The object to check
 * @returns true if the definition is a valid ThemeDefinition
 */
export function isThemeDefinition(definition: any): definition is ThemeDefinition {
  const validation = validateThemeDefinition(definition);
  return validation.isValid;
}

/**
 * Normalizes hex color to uppercase 6-character format
 * #RGB -> #RRGGBB
 * #rrggbb -> #RRGGBB
 *
 * @param color - The hex color to normalize
 * @returns Normalized hex color or original if invalid
 */
export function normalizeHexColor(color: string): string {
  if (!isValidHexColor(color)) {
    return color;
  }

  const hex = color.substring(1);

  // Expand 3-char format to 6-char
  if (hex.length === 3) {
    const expanded = hex.split('').map(c => c + c).join('');
    return `#${expanded.toUpperCase()}`;
  }

  return `#${hex.toUpperCase()}`;
}

/**
 * Normalizes all colors in a theme definition
 *
 * @param definition - The theme definition to normalize
 * @returns Normalized theme definition
 */
export function normalizeThemeDefinition(definition: ThemeDefinition): ThemeDefinition {
  const normalized: any = {};

  for (const color of REQUIRED_THEME_COLORS) {
    normalized[color] = normalizeHexColor(definition[color]);
  }

  return normalized as ThemeDefinition;
}
