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
 * All required color keys for a theme definition.
 *
 * Keys name a ROLE — what the color is for — not a swatch. This is the whole
 * point of the format: the old schema was 26 Catppuccin swatch names, so an
 * author who wanted a red accent had to write `blue: '#ff0000'`, and every
 * reader of that theme then had to know `blue` meant "accent". Issue #4567.
 *
 * Each key maps to `--color-<kebab-case>`; see `themeColorKeyToCssVar`.
 */
export const REQUIRED_THEME_COLORS = [
  // Backgrounds, furthest back to furthest forward
  'bg', 'bgRaised', 'bgSunken',
  'surface', 'surfaceHover', 'surfaceActive', 'surfaceInactive',
  // Text, highest to lowest emphasis
  'text', 'textMuted', 'textSubtle', 'textDisabled', 'textFaint',
  // Lines
  'border', 'borderStrong', 'borderSubtle',
  // Accents
  'accent', 'accentHover', 'accentAlt', 'accentMuted', 'accentText',
  // Status / feedback
  'success', 'error', 'warning', 'caution', 'info', 'danger'
] as const;

/**
 * Optional color keys.
 *
 * `chart1..8` are the CATEGORICAL scale — hues that only need to be tellable
 * apart, for encoding which source a row came from or which series a line is.
 * Optional because a theme that leaves them out still gets a usable eight-hue
 * scale from the defaults on `:root`; categorical colors do not have to match
 * the theme, they have to differ from each other.
 *
 * The `chatBubble*` keys override message bubble colors independently.
 */
export const OPTIONAL_THEME_COLORS = [
  'chart1', 'chart2', 'chart3', 'chart4',
  'chart5', 'chart6', 'chart7', 'chart8',
  'chatBubbleSentBg',
  'chatBubbleSentText',
  'chatBubbleReceivedBg',
  'chatBubbleReceivedText'
] as const;

/**
 * Theme definition key -> the CSS custom property it sets.
 *
 * `accentAlt` -> `--color-accent-alt`, `chart1` -> `--chart-1`.
 */
export function themeColorKeyToCssVar(key: string): string {
  if (/^chart[1-8]$/.test(key)) return `--chart-${key.slice(5)}`;
  return `--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
}

/**
 * Swatch-keyed (pre-#4567) definition key -> the role key(s) it becomes.
 *
 * One-to-many, because several roles shared a swatch and so could not be
 * themed apart: `overlay0` was faint text AND subtle borders AND the inactive
 * fill. Translating forward duplicates the value into each, which reproduces
 * the old appearance exactly while letting the author separate them later.
 *
 * Not listed, and dropped on purpose: `overlay2`, `teal`, `pink` and
 * `flamingo`. After #4619/#4620/#4622 no role, chart slot or component reads
 * them, so carrying them forward would preserve values nothing renders.
 */
const LEGACY_SWATCH_TO_ROLES: Record<string, string[]> = {
  base: ['bg'], mantle: ['bgRaised'], crust: ['bgSunken'],
  surface0: ['surface'],
  surface1: ['surfaceHover', 'border'],
  surface2: ['surfaceActive', 'borderStrong'],
  overlay0: ['textFaint', 'borderSubtle', 'surfaceInactive'],
  overlay1: ['textDisabled'],
  text: ['text'], subtext1: ['textMuted'], subtext0: ['textSubtle'],
  blue: ['accent'], sapphire: ['accentHover'],
  mauve: ['accentAlt'], lavender: ['accentMuted'],
  green: ['success'], red: ['error'], yellow: ['warning'],
  peach: ['caution'], sky: ['info'], maroon: ['danger']
};

/** Swatch that fed each categorical slot before the flip. */
const LEGACY_SWATCH_TO_CHART: Record<string, string> = {
  blue: 'chart1', mauve: 'chart2', green: 'chart3', peach: 'chart4',
  yellow: 'chart5', sapphire: 'chart6', maroon: 'chart7', rosewater: 'chart8'
};

/**
 * Keys that exist ONLY in the swatch format, so their presence identifies it.
 *
 * `text` is deliberately absent: it is a key in both formats, so it proves
 * nothing. Detection keys off what only the old format has, never off a new
 * key being missing — a half-written role definition must not be mistaken for
 * a legacy theme and silently rewritten.
 */
const LEGACY_ONLY_KEYS = ['base', 'crust', 'mantle', 'subtext0', 'subtext1',
                          'surface0', 'overlay0', 'overlay1'] as const;

/** True when a stored definition uses the old swatch keys. */
export function isLegacyThemeDefinition(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const record = definition as Record<string, unknown>;
  return LEGACY_ONLY_KEYS.some((key) => typeof record[key] === 'string');
}

/**
 * Translate a swatch-keyed definition into role keys.
 *
 * Returns the input unchanged if it is already in the role format, so this is
 * safe to call on every read. `accentText` has no swatch to come from — it was
 * a single global value, black, painted on bright fills — so it defaults to
 * that rather than being guessed from the palette.
 */
export function migrateLegacyThemeDefinition<T>(definition: T): T | Record<string, string> {
  if (!isLegacyThemeDefinition(definition)) return definition;

  const legacy = definition as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [swatch, roles] of Object.entries(LEGACY_SWATCH_TO_ROLES)) {
    const value = legacy[swatch];
    if (typeof value !== 'string') continue;
    for (const role of roles) out[role] = value;
  }
  for (const [swatch, slot] of Object.entries(LEGACY_SWATCH_TO_CHART)) {
    if (typeof legacy[swatch] === 'string') out[slot] = legacy[swatch] as string;
  }
  out.accentText = '#000000';

  // Chat bubble overrides were already role-ish; carry them through as-is.
  for (const key of ['chatBubbleSentBg', 'chatBubbleSentText',
                     'chatBubbleReceivedBg', 'chatBubbleReceivedText']) {
    if (typeof legacy[key] === 'string') out[key] = legacy[key] as string;
  }
  return out;
}

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

  // Validate optional colors if present
  for (const color of OPTIONAL_THEME_COLORS) {
    const value = definition[color];

    if (value !== undefined && !isValidHexColor(value)) {
      errors.push(`Invalid hex color for '${color}': ${value}`);
    }
  }

  // Check for unexpected properties (allow both required and optional)
  const allKnownColors: readonly string[] = [...REQUIRED_THEME_COLORS, ...OPTIONAL_THEME_COLORS];
  const extraKeys = Object.keys(definition).filter(
    key => !allKnownColors.includes(key)
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

  // Preserve and normalize optional colors if present
  for (const color of OPTIONAL_THEME_COLORS) {
    const value = (definition as any)[color];
    if (value !== undefined) {
      normalized[color] = normalizeHexColor(value);
    }
  }

  return normalized as ThemeDefinition;
}
