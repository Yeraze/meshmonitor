/**
 * Firmware download-URL helpers (#5011).
 *
 * Deliberately its own module rather than a member of firmwareUpdateService:
 * it is a pure function, and the route tests mock that whole service module,
 * which would leave this undefined at the point the route calls it.
 */

/**
 * Rewrite a GitHub *page* URL into the raw-content URL that actually serves
 * bytes (#5011).
 *
 * `github.com/<owner>/<repo>/blob/<ref>/<path>` renders an HTML page with the
 * file embedded in it. Pasting that link is the obvious mistake — it is the
 * URL the browser address bar shows when you look at the file — and before
 * this it was fetched, returned HTML, and failed with no explanation.
 *
 * Returns the input unchanged when it is not a recognised GitHub page URL, so
 * every other host is passed through untouched.
 */
export function resolveFirmwareDownloadUrl(rawUrl: string): { url: string; rewritten: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, rewritten: false };
  }

  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    return { url: rawUrl, rewritten: false };
  }

  // /<owner>/<repo>/blob/<ref>/<path...> — `raw` is the same shape and GitHub
  // already redirects it, but rewriting both keeps one code path.
  const segments = parsed.pathname.split('/').filter(Boolean);
  const kindIndex = segments.findIndex((seg) => seg === 'blob' || seg === 'raw');
  if (kindIndex !== 2 || segments.length < 5) {
    return { url: rawUrl, rewritten: false };
  }

  const [owner, repo] = segments;
  const rest = segments.slice(3).join('/');
  return {
    url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`,
    rewritten: true,
  };
}
