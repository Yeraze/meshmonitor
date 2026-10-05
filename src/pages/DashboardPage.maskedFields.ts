/**
 * Credentials in the source edit form.
 *
 * The form never seeds a password or token back into its input: the server
 * keeps the stored value when the field is left out of the save. What differs
 * per caller is how the form learns that a value IS stored:
 *
 *   admin       gets the full config, so the value is simply there.
 *   non-admin   gets the config with credentials masked, plus
 *               `maskedConfigFields` — the dotted paths of what was left out
 *               (`upstream.password`, `brokerUrl`).
 *
 * See utils/sourceConfigRedaction.ts on the server for the save rules these
 * helpers describe to the user.
 */

/** The part of a source the helpers read. */
export interface MaskedFieldSource {
  config?: Record<string, unknown> | null;
  maskedConfigFields?: string[];
}

function valueAt(config: Record<string, unknown> | null | undefined, path: string): unknown {
  let current: unknown = config;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** True when the server masked fields for this viewer (a non-admin editor). */
export function isMaskedForViewer(source: MaskedFieldSource | null | undefined): boolean {
  return Array.isArray(source?.maskedConfigFields);
}

/** True when the source holds a value for this credential, shown or not. */
export function hasStoredSecret(source: MaskedFieldSource | null | undefined, path: string): boolean {
  if (!source) return false;
  if (Array.isArray(source.maskedConfigFields)) return source.maskedConfigFields.includes(path);
  const value = valueAt(source.config, path);
  return typeof value === 'string' && value !== '';
}

/** True when a URL field has credentials or a query string the viewer was not shown. */
export function hasHiddenUrlParts(source: MaskedFieldSource | null | undefined, path: string): boolean {
  return Array.isArray(source?.maskedConfigFields) && source.maskedConfigFields.includes(path);
}

/**
 * Scheme, host and port of a URL, lower-cased — the server's notion of "the
 * same endpoint". Mirrors `urlEndpointIdentity` in sourceConfigRedaction.ts.
 */
export function endpointIdentity(url: string): string {
  const text = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text)?.[0] ?? '';
  const rest = text.slice(scheme.length);
  const afterCredentials = rest.slice(rest.lastIndexOf('@') + 1);
  const hostport = /^[^/?#]*/.exec(afterCredentials)?.[0] ?? '';
  return `${scheme}${hostport}`.toLowerCase();
}

/**
 * True when saving would drop a stored credential: the viewer is a non-admin,
 * a value is stored that they did not retype, and the URL it is sent to now
 * names another scheme, host or port.
 */
export function storedSecretWillBeDropped(
  source: MaskedFieldSource | null | undefined,
  secretPath: string,
  typedSecret: string,
  loadedUrl: string,
  currentUrl: string,
): boolean {
  if (!isMaskedForViewer(source) || typedSecret !== '') return false;
  if (!hasStoredSecret(source, secretPath)) return false;
  return endpointIdentity(loadedUrl) !== endpointIdentity(currentUrl);
}
