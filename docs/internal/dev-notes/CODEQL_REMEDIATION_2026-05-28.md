# CodeQL Remediation Plan — 2026-05-28

Snapshot of all 30 open CodeQL alerts on `Yeraze/meshmonitor` as of HEAD `cbc5aba6` (branch `feat/meshcore-auto-acknowledge`). Pulled via `gh api repos/Yeraze/meshmonitor/code-scanning/alerts`.

Each entry is classified into one of:

- **FIX** — real issue, code change required.
- **HARDEN** — existing mitigation is sound but worth strengthening (low effort, defence-in-depth).
- **DISMISS (mitigated)** — already mitigated in code; close as "won't fix → false positive" with the rationale cited inline in the dismissal.
- **DISMISS (by design)** — flagged behavior is intentional (firmware downloads, admin-configured outbound calls, etc.); close as "won't fix → used in tests / intentional".

## Triage summary

| # | Rule | Severity | Path:Line | Verdict |
|---|------|----------|-----------|---------|
| 137 | js/request-forgery | critical | settingsRoutes.ts:878 | DISMISS (mitigated) — `validateAppriseProbeUrl` blocks IMDS hostnames + 169.254/16 link-local + non-http(s); admin-only setting. Loopback/RFC1918 intentional (Apprise sidecar). |
| 88 | js/request-forgery | critical | tileServerTest.ts:537 | DISMISS (mitigated) — `safeFetch` + DNS SSRF guard active |
| 134 | js/insecure-helmet-configuration | high | server.ts:203 | DISMISS (by design) — `dynamicCspMiddleware` supplies CSP & frame-ancestors at request time |
| 30 | js/regex-injection | high | settingsRoutes.ts:210 | DISMISS (mitigated) — 100-char cap + catastrophic-pattern reject |
| 31 | js/regex-injection | high | server.ts:6069 | DISMISS (mitigated) — 200-char cap + catastrophic-pattern reject |
| 32 | js/regex-injection | high | server.ts:9889 | **HARDEN** — admin-only, all metachars escaped, but add overall length cap |
| 125 | js/resource-exhaustion | high | tileServerTest.ts:269 | DISMISS (mitigated) — `clampTimeout` bounds duration to `[1000, MAX]` |
| 126 | js/loop-bound-injection | high | autoResponderUtils.ts:33 | DISMISS (mitigated) — `MAX_TRIGGER_STR_LENGTH = 10000` slice before loop |
| 127 | js/unvalidated-dynamic-method-call | high | App.tsx:656 | DISMISS (mitigated) — `Object.prototype.hasOwnProperty.call` guard + `typeof === 'function'` |
| 141 | js/polynomial-redos | high | mqttBridgeManager.ts:168 | **FIX** — cap `rule.from.length` before `/\/+$/` strip |
| 142 | js/polynomial-redos | high | mqttBridgeManager.ts:169 | **FIX** — same, on `rule.to` |
| 143 | js/polynomial-redos | high | sourceRoutes.ts:142 | **FIX** — cap `r.from.length` before `/\/+$/` strip |
| 144 | js/polynomial-redos | high | sourceRoutes.ts:143 | **FIX** — same, on `r.to` |
| 147 | js/user-controlled-bypass | high | App.tsx:2938 | DISMISS (false positive) — `sourceType` selects which API endpoint to call; auth/perms enforced server-side |
| 148 | js/user-controlled-bypass | high | meshcoreManager.ts:2108 | DISMISS (false positive) — line is `timestamp: Date.now()` inside a success branch; no privilege gate |
| 97 | js/log-injection | medium | public/cors-detection.js:46 | DISMISS (false positive) — value is a numeric counter; logged in client console only |
| 108 | js/http-to-file-access | medium | upgradeService.ts:72 | DISMISS (mitigated) — path-resolve + DATA_DIR prefix check |
| 109 | js/http-to-file-access | medium | server.ts:10255 | DISMISS (mitigated) — `path.basename` + scripts-dir prefix check |
| 121 | js/file-access-to-http | medium | firmwareUpdateService.ts:1579 | DISMISS (by design) — direct-OTA firmware stream to attached node |
| 128 | js/log-injection | medium | logger.ts:59 | **FIX or DISMISS** — confirm `sanitizeForLog` runs on every arg path; codify with test |
| 129 | js/log-injection | medium | logger.ts:69 | same as #128 |
| 130 | js/log-injection | medium | logger.ts:79 | same as #128 |
| 131 | js/log-injection | medium | logger.ts:89 | same as #128 |
| 132 | js/http-to-file-access | medium | geojsonService.ts:203 | DISMISS (by design) — admin uploads GeoJSON layer; content is the artifact |
| 133 | js/http-to-file-access | medium | firmwareUpdateService.ts:872 | DISMISS (by design) — downloaded firmware blob staged to BACKUP_DIR |
| 136 | js/http-to-file-access | medium | firmwareUpdateService.ts:1423 | DISMISS (mitigated) — sanitized nodeId, JSON marker, prefix-checked path |
| 139 | js/session-fixation | medium | meshcoreRoutes.ts:1204 | DISMISS (false positive) — POST `/admin/login` is *remote MeshCore device* login; MeshMonitor session pre-exists via `requireAuth()` |
| 140 | js/session-fixation | medium | meshcoreRoutes.ts:1753 | same as #139 (`/admin/login-with-saved`) |
| 145 | js/session-fixation | medium | meshcoreRoutes.ts:1311 | same as #139 |
| 146 | js/session-fixation | medium | meshcoreRoutes.ts:1365 | same as #139 |

**Totals:** 4 FIX, 1 HARDEN, 4 FIX-or-DISMISS (logger needs verification), 21 DISMISS. (#137 reclassified to DISMISS after auditing `validateAppriseProbeUrl` — its existing IMDS/link-local/protocol checks already cover the realistic SSRF threats; loopback/RFC1918 are intentionally allowed for sidecar Apprise deployments.)

---

## A. Code changes (FIX)

### A1. Polynomial ReDoS on trailing-slash strip — 4 alerts (#141, #142, #143, #144)

Both call sites do `value.trim().replace(/\/+$/, '')`. CodeQL classifies anchored `\/+$` as polynomial-backtrackable on long all-slash strings. Whether it is actually polynomial in V8's engine is debatable, but the cheapest, audit-friendliest fix is a hard length cap on the input *before* the regex runs. Topic prefixes are short by MQTT convention.

**`src/server/mqttBridgeManager.ts:163-174`** — inside `applyTopicRewrite`:

```ts
const MAX_TOPIC_PREFIX_LEN = 256;
export function applyTopicRewrite(topic: string, rule: TopicRewriteRule | null | undefined): string {
  if (!rule) return topic;
  if (rule.from.length > MAX_TOPIC_PREFIX_LEN || rule.to.length > MAX_TOPIC_PREFIX_LEN) return topic;
  const from = rule.from.replace(/\/+$/, '');
  const to = rule.to.replace(/\/+$/, '');
  // ...
}
```

**`src/server/routes/sourceRoutes.ts:138-146`** — inside `checkOne`:

```ts
const r = rule as { from?: unknown; to?: unknown };
if (typeof r.from !== 'string' || typeof r.to !== 'string') {
  return `${label}.from and ${label}.to must be strings`;
}
if (r.from.length > 256 || r.to.length > 256) {
  return `${label}.from and ${label}.to must each be ≤ 256 characters`;
}
const from = r.from.trim().replace(/\/+$/, '');
const to = r.to.trim().replace(/\/+$/, '');
```

The validator path already errors on oversized values; the manager path silently no-ops to preserve the topic. Both behaviors match the existing error-handling style of their callers.

Tests:
- Extend `mqttBridgeManager.test.ts` (or add) with a 1MB-of-slashes `from` and assert (a) returns within a few ms, (b) returns the original topic.
- Extend `sourceRoutes.test.ts` with a 257-char `from` and assert 400 with the new message.

### A2. SSRF on Apprise probe — #137 — Audited, no code change

Audit outcome (2026-05-28): `validateAppriseProbeUrl` (`src/server/routes/settingsRoutes.ts:834`) and its `isBlockedAppriseProbeHost` helper already block:

- non-`http(s)` protocols (`file://`, `javascript:`, `ftp://`, …),
- AWS/Azure IPv4 IMDS (`169.254.169.254`),
- the whole `169.254.0.0/16` link-local range,
- GCP/Azure IMDS hostnames (case-insensitive, exact-match only).

It deliberately **accepts** `localhost` and RFC1918 because Apprise is most often deployed as a sidecar to MeshMonitor (Docker compose / LAN). `safeFetch` even in non-strict mode rejects loopback — adopting it here would break the documented sidecar deployment, with no real SSRF gain because the dangerous targets (IMDS) are already blocked syntactically before the fetch.

The setting is also gated by `requirePermission('settings', 'write')` (admin-only).

**Verdict**: reclassified to **DISMISS (mitigated)** in §B1. Comment to paste into the GitHub dismissal: see §B1 below.

### A3. Logger CWE-117 — #128–131 — Audited, false positive, regression test added

Audit outcome (2026-05-28): `logger.debug/info/warn/error` all wrap their arg list with `sanitizeArgs` → `sanitizeForLog` → `arg.replace(CONTROL_CHAR_RE, ' ')` before calling `console.{log,warn,error}`. `CONTROL_CHAR_RE` matches ASCII C0 (incl. `\r\n`), DEL, and C1. Every code path goes through the helper; CodeQL just doesn't trace through `sanitizeArgs` → `map` → `sanitizeForLog`.

**No code change.** Added regression coverage in `src/utils/logger.test.ts` (new `describe('logger sanitization (CWE-117 / CodeQL #128-131)')` block) asserting:

- CRLF in every log level is collapsed to space ("forged log line" attack defanged),
- NUL/BEL/ESC/DEL/CSI are stripped,
- non-string args pass through unchanged (so structured logging still works),
- interleaved string + object args sanitize correctly.

If a future refactor drops `sanitizeArgs` from any level, these tests fail.

**Verdict**: reclassified to **DISMISS (false positive)** in §B2. See §B2 for the GitHub dismissal comment.
3. If no: wrap the args. Pattern:

```ts
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map(a => typeof a === 'string' ? a.replace(CONTROL_CHAR_RE, ' ') : a);
}
export const logger = {
  debug: (...args: unknown[]) => shouldLog('debug') && console.log(...sanitizeArgs(args)),
  // …
};
```

   Add a unit test: pass `"injected\nFAKE LOG LINE"`, assert the recorded console output has no newline.

### A4. HARDEN — `js/regex-injection` #32 (auto-responder trigger compile)

The code at `server.ts:9889` builds `new RegExp('^${escaped}$', 'i')` where every non-replacement char is escaped via `/[.*+?^${}()|[\]\\]/`. Admin-controlled, no user injection, escaping is exhaustive. CodeQL is being conservative.

Low-effort hardening: add a length cap on `regexPattern` before compile (e.g. 500 chars) — matches the spirit of the caps on #30/#31. This also gives CodeQL a hook to be quiet. Either way, the recommendation is fine as a hardening step in the same PR.

---

## B. Dismissals (CodeQL UI "Won't fix" with the rationales below)

When dismissing, paste the listed rationale into the dismissal comment so the audit trail is self-explanatory.

### B1. Mitigated in code (dismiss as `won't fix` / `false positive`)

- **#137 (settingsRoutes.ts:878) — request-forgery** — `probeUrl` is the output of `validateAppriseProbeUrl` (settingsRoutes.ts:834), which blocks non-`http(s)` protocols, AWS/Azure IPv4 IMDS (`169.254.169.254`), the full `169.254.0.0/16` link-local range, and GCP/Azure IMDS hostnames. Loopback / RFC1918 are intentionally accepted (Apprise is typically a sidecar). Setting is admin-only via `requirePermission('settings', 'write')`. Test coverage in `settingsRoutes.test.ts:657-728`.
- **#88 (tileServerTest.ts:537) — request-forgery** — call site uses `safeFetch` (`src/server/routes/tileServerTest.ts:520`) which performs DNS resolution and rejects loopback, RFC1918, link-local, ULA. SSRF blocked at the helper layer.
- **#30 (settingsRoutes.ts:210), #31 (server.ts:6069) — regex-injection** — both call sites cap pattern length (100 and 200 chars) and reject catastrophic-backtracking sub-patterns (`/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/`) before `new RegExp`.
- **#125 (tileServerTest.ts:269) — resource-exhaustion** — `clampTimeout` (lines ~238-243) bounds the value to `[1000, MAX_TILE_TEST_TIMEOUT_MS]`.
- **#126 (autoResponderUtils.ts:33) — loop-bound-injection** — `MAX_TRIGGER_STR_LENGTH = 10000`; the loop iterates over a sliced copy, not the raw input.
- **#127 (App.tsx:656) — unvalidated-dynamic-method-call** — call gated by `Object.prototype.hasOwnProperty.call(tabPermissions, activeTab)` + `typeof permissionCheck === 'function'`; cannot dispatch to `toString`/`__proto__`.
- **#108 (upgradeService.ts:72) — http-to-file-access** — `atomicWriteFile` resolves both `DATA_DIR` and `filePath` and rejects writes that don't share the data-dir prefix. All callers pass compile-time constants.
- **#109 (server.ts:10255) — http-to-file-access** — filename runs through `path.basename` (strips traversal) and the resolved path is checked against `resolvedScriptsDir + path.sep`.
- **#136 (firmwareUpdateService.ts:1423) — http-to-file-access** — nodeId goes through `sanitizeNodeId`, content is a fixed-shape JSON marker, and resolved path is prefix-checked against `BACKUP_DIR`.

### B2. False positives

- **#128 / #129 / #130 / #131 (logger.ts) — log-injection** — every public level (`debug`/`info`/`warn`/`error`) wraps its arg list in `sanitizeArgs` → `sanitizeForLog` → `replace(CONTROL_CHAR_RE, ' ')`, which collapses ASCII C0 (incl. CR/LF), DEL, and C1 controls to a single space before `console.*` is called. CodeQL's dataflow does not trace through `Array.prototype.map`. Regression coverage in `src/utils/logger.test.ts` ("logger sanitization (CWE-117 / CodeQL #128-131)" describe block).
- **#147 (App.tsx:2938) — user-controlled-bypass** — `sourceType === 'meshcore'` is a *routing* discriminator (which REST endpoint to call), not an authorization gate. Server enforces auth + per-source permissions on every endpoint behind this branch.
- **#148 (meshcoreManager.ts:2108) — user-controlled-bypass** — line 2108 is literally `timestamp: Date.now()` inside a response-success branch of `sendBridgeCommand`. The "user-controlled" value (the success boolean) comes from the bridge process the server owns; there is no privilege boundary at this line.
- **#97 (cors-detection.js:46) — log-injection** — value logged is `corsErrorCount` (a `Number` incremented locally). Numbers can't carry CRLF.
- **#139 / #140 / #145 / #146 (meshcoreRoutes.ts) — session-fixation** — these routes (`/admin/login`, `/admin/login-with-saved`, etc.) log the caller into a **remote MeshCore device** (admin password challenge over the mesh), not into MeshMonitor. The MeshMonitor session is already established and was already validated by `requireAuth()` + `requirePermission('remote_admin', 'write')` earlier in the same handler chain. No express-session manipulation occurs in these handlers.

### B3. By-design behaviors

- **#134 (server.ts:203) — insecure-helmet-configuration** — `contentSecurityPolicy: false` and `frameguard: false` are intentional. The replacement `dynamicCspMiddleware` (`src/server/middleware/dynamicCsp.ts`) injects a dynamic CSP using runtime-known tile-server hostnames and frame-ancestors driven by `IFRAME_ALLOWED_ORIGINS`. Helmet's static config can't express either, so it's disabled at the Helmet layer and re-added by the next middleware.
- **#121 (firmwareUpdateService.ts:1579) — file-access-to-http** — streams a downloaded firmware `.bin` to the attached node over TCP. This is the entire purpose of the direct-OTA path.
- **#132 (geojsonService.ts:203) — http-to-file-access** — admins upload GeoJSON layers to be served by the map UI; the file content *is* the upload. Path-traversal is already blocked at line 200 via resolve+prefix check.
- **#133 (firmwareUpdateService.ts:872) — http-to-file-access** — downloaded firmware blob is staged to `BACKUP_DIR` so it can be re-flashed without re-downloading. Path is sanitized + prefix-checked.

---

## C. Suggested execution order

Stage in two PRs to keep diffs reviewable and to separate "code change" risk from "alert hygiene" risk.

### PR 1 — Code fixes (FIX + HARDEN)

1. Polynomial-ReDoS fix in `mqttBridgeManager.ts` + `sourceRoutes.ts` (A1) — small, mechanical, two unit tests.
2. Apprise SSRF fix in `settingsRoutes.ts` (A2) — needs reading `validateAppriseProbeUrl` first. May lift `safeFetch` to a shared utility if it isn't already.
3. Logger sanitization verification + (if needed) wrapper (A3).
4. Regex compile length cap in `server.ts:9875-9905` (A4).
5. Run `npm test`, push, watch `/ci-monitor`.

### PR 2 — Mark dismissals on GitHub

After PR 1 merges, dismiss the 20 alerts in §B with the prepared rationales. This can be batched with `gh api -X PATCH repos/Yeraze/meshmonitor/code-scanning/alerts/<n>` calls (state=dismissed, dismissed_reason=`"false positive"` or `"won't fix"`, dismissed_comment=<rationale>). No code change in this PR.

If CodeQL re-opens any of the §B1 mitigated alerts after a refactor, that's the signal that the mitigation was removed; re-evaluate at that point.

### Followups (not blockers)

- Consider adopting `re2` (or `safe-regex2`) for the three admin-supplied regex paths so CodeQL can prove non-catastrophicness instead of relying on syntactic blocklists.
- If the Apprise SSRF lift happens, do a sweep for any other `fetch(<user-influenced URL>)` call sites not already on `safeFetch` and migrate them at once.
