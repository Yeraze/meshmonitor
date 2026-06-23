/**
 * Variable value codec (#3653, §5.2).
 *
 * Pure, DB-free helpers the engine uses to translate between typed JS values and
 * the type-agnostic string stored in `automation_variable_values.value`, plus the
 * flag-expiry computation. The repository stays type-agnostic; all type/config
 * awareness lives here.
 */
import type { VariableType } from '../../../types/automation.js';

export interface ParsedVarConfig {
  /** flag type only: seconds after which the flag auto-clears. */
  flagDurationSeconds?: number;
  /** seeded value used when no stored value exists. */
  defaultValue?: unknown;
}

export type DecodedValue = string | number | boolean | null;

/** Parse the JSON `config` column, tolerating malformed/empty input. */
export function parseVarConfig(config: string | null | undefined): ParsedVarConfig {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === 'object' ? (parsed as ParsedVarConfig) : {};
  } catch {
    return {};
  }
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return Boolean(value);
}

/**
 * Encode a typed JS value to its stored string form. Returns null when the value
 * cannot be represented as the given type (e.g. a non-numeric integer) so the
 * caller can reject the write.
 */
export function encodeValue(type: VariableType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return value == null ? null : String(value);
    case 'integer': {
      const n = typeof value === 'string' ? Number(value) : (value as number);
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      return String(Math.trunc(n));
    }
    case 'float': {
      const n = typeof value === 'string' ? Number(value) : (value as number);
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      return String(n);
    }
    case 'boolean':
    case 'flag':
      return toBool(value) ? 'true' : 'false';
    default:
      return null;
  }
}

/** Decode a stored string back into a typed JS value. */
export function decodeValue(type: VariableType, raw: string | null): DecodedValue {
  if (raw == null) return null;
  switch (type) {
    case 'string':
      return raw;
    case 'integer': {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'float': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
    case 'flag':
      return raw === 'true' || raw === '1';
    default:
      return null;
  }
}

/**
 * Compute the absolute expiry timestamp (ms) for arming a flag, or null when the
 * variable has no positive duration (never expires). Only meaningful for `flag`.
 */
export function flagExpiry(config: ParsedVarConfig, now: number): number | null {
  const secs = config.flagDurationSeconds;
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return null;
  return now + Math.round(secs * 1000);
}
