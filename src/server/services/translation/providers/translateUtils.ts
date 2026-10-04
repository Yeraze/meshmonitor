/**
 * Helper to construct the full endpoint path for translation services.
 *
 * Rules:
 * 1. If baseUrl is empty or only whitespace, return defaultEndpoint.
 * 2. If no protocol (http:// or https://) is provided, inherit the protocol from defaultEndpoint
 *    (or fallback to https:// if defaultEndpoint is unspecified/invalid).
 * 3. If a bare origin is provided (e.g. "http://host", "https://host:5000", "localhost:5000"),
 *    append the provider's defaultPath (e.g. "/v1/chat/completions", "/v2/translate", "/translate").
 * 4. If a URL's path ends in a version segment (e.g. "/v1", "/v2/", "/api/v1", "/openai/v1"), it is
 *    a base URL: append versionSubpath if provided (e.g. "/chat/completions" or "/translate").
 *    OpenRouter ("/api/v1") and Groq ("/openai/v1") publish their base URL this way.
 * 5. Any other path (e.g. "https://host/api/translate", "https://host/v1/chat/completions") is used
 *    verbatim as the full endpoint (stripping any trailing slash). A provider with no versionSubpath
 *    (LibreTranslate) uses every path verbatim.
 *
 * @param baseUrl The configured base URL or full endpoint URL.
 * @param defaultEndpoint The default fallback endpoint when baseUrl is empty.
 * @param defaultPath The default path to append if a bare origin is provided.
 * @param versionSubpath Optional subpath to append when baseUrl's path ends in a version segment.
 * @returns The resolved endpoint URL.
 */
export function buildServiceEndpoint(
  baseUrl: string,
  defaultEndpoint: string,
  defaultPath: string,
  versionSubpath?: string
): string {
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
  } else if (versionSubpath && /\/v\d+\/?$/i.test(parsed.pathname)) {
    // Path ends in a version segment (e.g. '/v1', '/v2/', '/api/v1', '/openai/v1'): a base URL
    const cleanVersion = parsed.pathname.replace(/\/+$/, '');
    const normalizedSubpath = versionSubpath.startsWith('/') ? versionSubpath : `/${versionSubpath}`;
    parsed.pathname = `${cleanVersion}${normalizedSubpath}`;
  } else {
    // Any other path is the full endpoint: strip trailing slashes
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}
