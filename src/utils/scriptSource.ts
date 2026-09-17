/**
 * Where an installed user script came from, and which version is newer (#5255).
 *
 * A script's update source is a GitHub file: `owner/repo/path/to/script.py`,
 * optionally with a branch (`owner/repo/tree/branch/path`), or the same thing
 * as a github.com URL. MeshMonitor fetches it through the GitHub Contents API,
 * so it never has to guess a default branch.
 *
 * Nothing here touches the network or the filesystem, so both the server and
 * the UI can use it.
 */

export interface ScriptSource {
  owner: string;
  repo: string;
  /** Path inside the repo, no leading slash. */
  path: string;
  /** Branch or tag, when the source pinned one. */
  ref?: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const OWNER_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** The one host we fetch script contents from. */
export const GITHUB_API_HOST = 'api.github.com';

/**
 * Parse an update source. Returns null for anything that is not a plain GitHub
 * file path, which is what keeps a source string from steering a request
 * somewhere else.
 */
export function parseScriptSource(raw: unknown): ScriptSource | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;

  // Accept a github.com URL by reducing it to owner/repo/...
  const webUrl = value.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
  // A raw URL carries its ref as the third segment with no `blob` marker
  // (owner/repo/REF/path), so name it explicitly rather than leaving the ref
  // stuck on the front of the path, which would 404.
  const rawUrl = value.match(/^https?:\/\/raw\.githubusercontent\.com\/(.+)$/i);
  if (webUrl) {
    value = webUrl[1];
  } else if (rawUrl) {
    const parts = rawUrl[1].split('/').filter(Boolean);
    if (parts.length < 4) return null;
    value = [parts[0], parts[1], 'blob', ...parts.slice(2)].join('/');
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // Any other scheme (file:, http: to another host, …) is not a source.
    return null;
  }

  // Split rather than regex: a query or fragment strip with `.*` on
  // user-controlled input is a ReDoS shape, and this is unambiguously linear.
  value = value.split('?')[0].split('#')[0].replace(/^\/+/, '');
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  if (parts.some(p => p === '.' || p === '..' || !SEGMENT.test(p))) return null;

  const [owner, repo, ...rest] = parts;
  if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) return null;

  // `blob`/`tree`/`raw` mark a ref in github.com URLs: owner/repo/blob/main/x.py
  let ref: string | undefined;
  let pathParts = rest;
  if (['blob', 'tree', 'raw'].includes(rest[0]) && rest.length >= 3) {
    ref = rest[1];
    pathParts = rest.slice(2);
  }
  if (pathParts.length === 0) return null;

  return { owner, repo, path: pathParts.join('/'), ...(ref ? { ref } : {}) };
}

/** The Contents API URL for a source. Without a ref, GitHub uses the default branch. */
export function scriptSourceApiUrl(source: ScriptSource): string {
  const path = source.path.split('/').map(encodeURIComponent).join('/');
  const base = `https://${GITHUB_API_HOST}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${path}`;
  return source.ref ? `${base}?ref=${encodeURIComponent(source.ref)}` : base;
}

/** A human-facing link to the file on github.com. */
export function scriptSourceWebUrl(source: ScriptSource): string {
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.ref ?? 'HEAD'}/${source.path}`;
}

/** How a source string reads in the UI. */
export function formatScriptSource(source: ScriptSource): string {
  return `${source.owner}/${source.repo}/${source.path}${source.ref ? ` (${source.ref})` : ''}`;
}

/**
 * Compare two version strings the way script authors write them: dot-separated
 * numbers, with an optional pre-release suffix that sorts BEFORE the same
 * numbers without one (1.2.0-beta.1 < 1.2.0), as semver does.
 *
 * Returns a negative number when `a` is older, 0 when they match, positive when
 * `a` is newer. Unparseable input compares as equal, so a weird version never
 * claims an update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)(?:[-+](.+))?$/);
    if (!m) return null;
    return { nums: m[1].split('.').map(Number), pre: m[2] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // release beats pre-release
  if (pb.pre === null) return -1;

  // Compare pre-release identifiers the way semver does: dot-separated, numeric
  // parts numerically, so beta.9 sorts before beta.10 rather than after it.
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const xa = ia[i];
    const xb = ib[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const d = Number(xa) - Number(xb);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `latest` is a version worth offering over `installed`. */
export function isUpdateAvailable(installed: string | null | undefined, latest: string | null | undefined): boolean {
  if (!installed || !latest) return false;
  return compareVersions(latest, installed) > 0;
}
