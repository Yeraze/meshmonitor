/**
 * Helper to construct the full endpoint path for translation services.
 *
 * Rules:
 * 1. If baseUrl is empty or only whitespace, return defaultEndpoint.
 * 2. If no protocol (http:// or https://) is provided, prepend https://.
 * 3. If a bare origin is provided (e.g. "http://host", "https://host:5000", "localhost:5000"),
 *    append the provider's default path (e.g. "/translate").
 * 4. If a URL is provided with a path beyond the origin (e.g. "https://host/api/translate",
 *    "http://proxy:8080/custom/v1"), use it verbatim as the full endpoint (stripping any trailing slash).
 *
 * @param baseUrl The configured base URL or full endpoint URL.
 * @param defaultEndpoint The default fallback endpoint when baseUrl is empty.
 * @param defaultPath The default path to append if a bare origin is provided (e.g. '/translate').
 * @returns The resolved endpoint URL.
 */
export function buildServiceEndpoint(baseUrl: string, defaultEndpoint: string, defaultPath: string): string {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) {
    return defaultEndpoint;
  }

  // Derive protocol from defaultEndpoint if baseUrl doesn't specify one
  let defaultProtocol = 'https:';
  try {
    if (defaultEndpoint) {
      const parsedDefault = new URL(defaultEndpoint);
      if (parsedDefault.protocol) {
        defaultProtocol = parsedDefault.protocol;
      }
    }
  } catch {
    defaultProtocol = 'https:';
  }

  // If a URL scheme is already present (e.g. http://, https://, ftp://, file:///), use it as-is.
  // Otherwise, inherit the protocol from defaultEndpoint.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const withProtocol = hasScheme ? trimmed : `${defaultProtocol}//${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid URL: ${baseUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid URL protocol: ${baseUrl}`);
  }

  const normalizedPath = defaultPath.startsWith('/') ? defaultPath : `/${defaultPath}`;

  // Bare origin check (pathname is empty or '/')
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = normalizedPath;
  } else {
    // Path beyond origin: strip trailing slashes
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}
