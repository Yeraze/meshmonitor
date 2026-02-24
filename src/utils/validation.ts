/**
 * Input validation utilities for sanitizing and validating user inputs
 */

/**
 * Sanitize text input to prevent XSS attacks
 * Removes or escapes potentially dangerous characters
 */
export function sanitizeTextInput(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Remove null bytes and control characters
  let sanitized = text.replace(/[\x00-\x1F\x7F]/g, '');

  // Limit length to prevent DoS
  const MAX_MESSAGE_LENGTH = 1000;
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.substring(0, MAX_MESSAGE_LENGTH);
  }

  return sanitized.trim();
}

/**
 * Validate channel number
 */
export function validateChannel(channel: number | undefined): number | undefined {
  if (channel === undefined) {
    return undefined;
  }

  // Channel must be a non-negative integer
  if (!Number.isInteger(channel) || channel < 0 || channel > 7) {
    throw new Error('Invalid channel number. Must be between 0 and 7.');
  }

  return channel;
}

/**
 * Validate node ID format
 */
export function validateNodeId(nodeId: string | undefined): string | undefined {
  if (!nodeId) {
    return undefined;
  }

  // Node ID should match the format !XXXXXXXX (8 hex characters)
  const nodeIdPattern = /^![0-9a-fA-F]{8}$/;
  if (!nodeIdPattern.test(nodeId)) {
    throw new Error('Invalid node ID format. Expected format: !XXXXXXXX');
  }

  return nodeId;
}

/**
 * Validate hours parameter for purge operations
 */
export function validateHours(hours: number): number {
  if (!Number.isInteger(hours) || hours < 0 || hours > 8760) { // Max 1 year
    throw new Error('Invalid hours value. Must be between 0 and 8760.');
  }
  return hours;
}

/**
 * Validate interval minutes
 */
export function validateIntervalMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { // Max 24 hours
    throw new Error('Invalid interval. Must be between 1 and 1440 minutes.');
  }
  return minutes;
}