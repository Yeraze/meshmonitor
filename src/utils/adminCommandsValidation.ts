/**
 * Validation utilities for Admin Commands
 * 
 * Provides validation functions for position config, admin keys, and other admin command inputs.
 */

export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
}

export interface PositionConfigValidation {
  positionBroadcastSecs?: number;
  nodeInfoBroadcastSecs?: number;
  gpsUpdateInterval?: number;
  broadcastSmartMinimumIntervalSecs?: number;
  fixedLatitude?: number;
  fixedLongitude?: number;
  fixedAltitude?: number;
  rxGpio?: number;
  txGpio?: number;
  gpsEnGpio?: number;
}

/**
 * Validate position broadcast interval
 * @param value - Interval in seconds
 * @returns Error message if invalid, undefined if valid
 */
export function validateBroadcastInterval(value: number): string | undefined {
  if (value < 0 || value > 86400) {
    return 'Must be between 0 and 86400 seconds (0-24 hours)';
  }
  if (value > 0 && value < 32) {
    return 'Minimum interval is 32 seconds';
  }
  return undefined;
}

/**
 * Validate latitude value
 * @param value - Latitude coordinate
 * @returns Error message if invalid, undefined if valid
 */
export function validateLatitude(value: number): string | undefined {
  if (value < -90 || value > 90) {
    return 'Latitude must be between -90 and 90 degrees';
  }
  return undefined;
}

/**
 * Validate longitude value
 * @param value - Longitude coordinate
 * @returns Error message if invalid, undefined if valid
 */
export function validateLongitude(value: number): string | undefined {
  if (value < -180 || value > 180) {
    return 'Longitude must be between -180 and 180 degrees';
  }
  return undefined;
}

/**
 * Validate altitude value (reasonable range)
 * @param value - Altitude in meters
 * @returns Error message if invalid, undefined if valid
 */
export function validateAltitude(value: number): string | undefined {
  // Reasonable altitude range: -500m (below sea level) to 9000m (Mount Everest)
  if (value < -500 || value > 9000) {
    return 'Altitude must be between -500 and 9000 meters';
  }
  return undefined;
}

/**
 * Validate GPIO pin number
 * @param value - GPIO pin number
 * @returns Error message if invalid, undefined if valid
 */
export function validateGpioPin(value: number | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined; // Optional field
  }
  // Most microcontrollers have GPIO pins 0-255, but some have more
  // Using a reasonable upper bound
  if (value < 0 || value > 255) {
    return 'GPIO pin must be between 0 and 255';
  }
  return undefined;
}

/**
 * Validate position configuration
 * @param config - Position config object to validate
 * @returns Validation result with errors
 */
export function validatePositionConfig(config: PositionConfigValidation): ValidationResult {
  const errors: Record<string, string> = {};

  if (config.positionBroadcastSecs !== undefined) {
    const error = validateBroadcastInterval(config.positionBroadcastSecs);
    if (error) errors.positionBroadcastSecs = error;
  }

  if (config.nodeInfoBroadcastSecs !== undefined) {
    const error = validateBroadcastInterval(config.nodeInfoBroadcastSecs);
    if (error) errors.nodeInfoBroadcastSecs = error;
  }

  if (config.gpsUpdateInterval !== undefined) {
    const error = validateBroadcastInterval(config.gpsUpdateInterval);
    if (error) errors.gpsUpdateInterval = error;
  }

  if (config.broadcastSmartMinimumIntervalSecs !== undefined) {
    const error = validateBroadcastInterval(config.broadcastSmartMinimumIntervalSecs);
    if (error) errors.broadcastSmartMinimumIntervalSecs = error;
  }

  if (config.fixedLatitude !== undefined) {
    const error = validateLatitude(config.fixedLatitude);
    if (error) errors.fixedLatitude = error;
  }

  if (config.fixedLongitude !== undefined) {
    const error = validateLongitude(config.fixedLongitude);
    if (error) errors.fixedLongitude = error;
  }

  if (config.fixedAltitude !== undefined) {
    const error = validateAltitude(config.fixedAltitude);
    if (error) errors.fixedAltitude = error;
  }

  if (config.rxGpio !== undefined) {
    const error = validateGpioPin(config.rxGpio);
    if (error) errors.rxGpio = error;
  }

  if (config.txGpio !== undefined) {
    const error = validateGpioPin(config.txGpio);
    if (error) errors.txGpio = error;
  }

  if (config.gpsEnGpio !== undefined) {
    const error = validateGpioPin(config.gpsEnGpio);
    if (error) errors.gpsEnGpio = error;
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validate admin key format
 * @param key - Admin key string (base64 or hex)
 * @returns Validation result with error message if invalid
 */
export function validateAdminKey(key: string): { isValid: boolean; error?: string } {
  // Empty key is valid (will be filtered out)
  if (!key || key.trim().length === 0) {
    return { isValid: true };
  }

  const trimmed = key.trim();

  // Check base64 format
  if (trimmed.startsWith('base64:')) {
    const base64 = trimmed.substring(7);
    if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
      return { isValid: false, error: 'Invalid base64 format. Use only A-Z, a-z, 0-9, +, /, and = characters' };
    }
    // Base64 encoding of 32 bytes = 44 characters (including padding)
    if (base64.length !== 44) {
      return { isValid: false, error: `Base64 key must be 44 characters (32 bytes). Current length: ${base64.length}` };
    }
    return { isValid: true };
  }

  // Check hex format (with or without 0x prefix)
  const hex = trimmed.startsWith('0x') ? trimmed.substring(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return { isValid: false, error: 'Invalid hex format. Use only 0-9 and a-f characters (with or without 0x prefix)' };
  }
  // Hex encoding of 32 bytes = 64 characters
  if (hex.length !== 64) {
    return { isValid: false, error: `Hex key must be 64 characters (32 bytes). Current length: ${hex.length}` };
  }

  return { isValid: true };
}

/**
 * Validate all admin keys
 * @param keys - Array of admin key strings
 * @returns Validation result with errors for each invalid key
 */
export function validateAdminKeys(keys: string[]): ValidationResult {
  const errors: Record<string, string> = {};

  keys.forEach((key, index) => {
    // Skip empty keys (they'll be filtered out)
    if (!key || key.trim().length === 0) {
      return;
    }

    const validation = validateAdminKey(key);
    if (!validation.isValid && validation.error) {
      errors[`adminKey_${index}`] = validation.error;
    }
  });

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

