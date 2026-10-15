# Passkey login — spec (#5841)

Status: **draft for maintainer review**. No code until this is approved.

## 1. Decisions already made (interview, 2026-10-15)

| # | Decision |
|---|----------|
| D1 | Phase 1 = sign in with a passkey, admin can view/revoke passkeys, **passkey-only accounts**. |
| D2 | Passkey-only recovery = **one-time recovery codes**, shown when password login is turned off. |
| D3 | The last admin **may** turn off their own password, after a warning and typed confirmation. |
| D4 | **Local-auth users only.** OIDC and proxy-auth users cannot register passkeys. |

## 2. What exists today

- `POST /api/auth/login` (`src/server/routes/authRoutes.ts`) → `authenticateLocal()` → `regenerateSession()` → sets `req.session.{userId, username, authProvider:'local', isAdmin}`.
- TOTP MFA: `users.mfa_enabled / mfa_secret / mfa_backup_codes`. A password login with MFA on parks `req.session.pendingMfaUserId` and finishes in `POST /api/auth/verify-mfa`.
- `src/server/services/mfa.ts` already generates, bcrypt-hashes and consumes one-time backup codes. **The recovery codes in D2 reuse this service** rather than adding a second implementation.
- `users.password_locked` stops a user changing their own password (admin-set). `DISABLE_LOCAL_AUTH` turns off local login entirely.
- Express `trust proxy` is off unless `TRUST_PROXY` is set; session cookie `secure` follows `COOKIE_SECURE`.

## 3. Library

`@simplewebauthn/server` (server) and `@simplewebauthn/browser` (client), MIT, the de facto standard. Pin exact versions; the browser package is lazy-loaded on the login page and profile page so it stays out of the main chunk (`check:bundle-size`).

## 4. Data model

New table **`user_passkeys`** (all three backends, one migration):

| Column | Type | Notes |
|--------|------|-------|
| `id` | PK | |
| `user_id` | FK → users, `ON DELETE CASCADE` | |
| `credential_id` | text, **unique** | base64url |
| `public_key` | text | base64url of the COSE key (text, not BLOB, so one type works on all three backends) |
| `counter` | bigint | signature counter; see §7 |
| `transports` | text | JSON array |
| `device_type` | text | `singleDevice` / `multiDevice` |
| `backed_up` | boolean | |
| `rp_id` | text | hostname the passkey was registered on (§5) |
| `nickname` | text | user-chosen, max 64 chars |
| `created_at`, `last_used_at` | bigint (ms) | |

New columns on **`users`**:

| Column | Type | Notes |
|--------|------|-------|
| `password_login_disabled` | boolean, default false | D1 passkey-only switch |
| `passkey_recovery_codes` | text, nullable | JSON array of bcrypt hashes (same format as `mfa_backup_codes`) |

Backup: `user_passkeys` goes in `BACKUP_TABLES` **and** `BACKUP_SECRET_TABLES` (public keys are not secret, but credential IDs plus user IDs are account data; treat like other auth tables). `systemBackupService.tables.test.ts` enforces the classification.

## 5. Relying party (RP) identity

WebAuthn binds a credential to an **RP ID** (a hostname) and checks the **origin**. Self-hosters reach MeshMonitor many ways (LAN IP, `.local`, reverse-proxied domain), so this is the main deployment trap.

- New optional env vars: `WEBAUTHN_RP_ID` (e.g. `mesh.example.com`) and `WEBAUTHN_ORIGINS` (comma list, e.g. `https://mesh.example.com`).
- If unset, derive both from the request (`req.hostname`, `req.protocol`), which is correct only when `TRUST_PROXY` is right behind a proxy. Log a one-time warning at startup when unset.
- A passkey registered on one hostname will **not** work on another. The profile UI shows the hostname each passkey is bound to (store the RP ID used at registration in a `rp_id` column, so this is exact).
- WebAuthn needs a **secure context** (HTTPS, or `http://localhost`). On plain-HTTP LAN installs the browser API is absent: the client hides every passkey control when `!window.isSecureContext || !window.PublicKeyCredential`, and the profile page explains why in one line.

## 6. Routes (`src/server/routes/passkeyRoutes.ts`, mounted at `/api/auth/passkey`)

All use `ok()` / `fail()`. Challenges live in the session (`req.session.webauthnChallenge`, with a 5-minute expiry stamp) and are deleted on first use, success or failure.

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /register/options` | requireAuth, local users only (D4) | `generateRegistrationOptions`; `excludeCredentials` = user's existing passkeys; `residentKey: 'preferred'`, `userVerification: 'preferred'`. |
| `POST /register/verify` | requireAuth | `verifyRegistrationResponse`; insert row; audit `passkey_registered`. |
| `POST /login/options` | none, `authLimiter` | `generateAuthenticationOptions` with **empty `allowCredentials`** (discoverable, username-less). No username input → no account enumeration. |
| `POST /login/verify` | none, `authLimiter` | Look up by `credential_id`; reject inactive users, non-local users, or when `DISABLE_LOCAL_AUTH`; `verifyAuthenticationResponse`; update counter + `last_used_at`; `regenerateSession()`; set the same session fields as password login with `authProvider: 'local'`; audit `login_success` with `method: 'passkey'`. |
| `GET /` | requireAuth | List the caller's passkeys (no key material). |
| `PATCH /:id` | requireAuth, owner | Rename. |
| `DELETE /:id` | requireAuth, owner | Delete. **Refused** if it is the last passkey while `password_login_disabled` is true (would lock the user out). |
| `POST /password-login` | requireAuth, owner | Body `{ disabled: boolean, confirm?: string }`. See §8. |
| `POST /recover` | none, `authLimiter` | Body `{ username, code }`. See §8. |
| `GET /admin/users/:userId` · `DELETE /admin/users/:userId/:id` | admin | D1 admin view/revoke; audit `passkey_revoked_by_admin`. |

Every route that ends a session or changes credentials calls `notifyAccessChange` the way logout does, so open WebSockets re-check.

## 7. Security rules

- **TOTP and passkeys:** a passkey login **does not** ask for the TOTP code. A passkey with user verification is already two factors (device + biometric/PIN). Password login keeps asking for TOTP as today. *(Open question Q1.)*
- **Counter:** reject an authentication whose counter is non-zero and not greater than the stored one (cloned authenticator). Synced passkeys report 0 forever; 0 is accepted.
- **Rate limiting:** `/login/*` and `/recover` share `authLimiter` with password login.
- **Audit:** register, rename, delete, admin revoke, password-login on/off, recovery-code use, and failed passkey verifications (`login_failed`, `method: 'passkey'`).
- **No new authProvider value.** A passkey is a second credential on a local user, so every existing `authProvider === 'local'` check keeps working.

## 8. Passkey-only accounts (D1–D3)

**Turning password login off** (`POST /password-login { disabled: true }`):

1. Requires at least one registered passkey **and** a passkey login in this session within the last 10 minutes (stops someone at an unlocked, password-logged-in browser from doing it).
2. Generates 10 recovery codes with `mfaService.generateBackupCodes()`, stores bcrypt hashes in `passkey_recovery_codes`, returns the plain codes **once**. The UI makes the user tick "I saved these" before closing.
3. **Last admin (D3):** if the caller is the only active admin, the response first returns `requireConfirm: true`; the client shows a warning and the user types `DISABLE` to resend with `confirm: 'DISABLE'`. Allowed, not blocked.

**While disabled:** `POST /api/auth/login` returns the same `401 Invalid username or password` as a bad password, so the switch is not revealed to an attacker. `POST /change-password` is refused.

**Turning it back on** (`{ disabled: false }`): clears the flag and the recovery codes.

**Recovery** (`POST /recover { username, code }`): verifies one code with `mfaService.verifyBackupCode`, consumes it, signs the user in, and **turns password login back on** with a forced password change on next page (reuses the existing default-password prompt). A generic error for every failure. Admins can also recover a user by setting a new password in the Users tab, which turns password login back on.

## 9. UI

- **Login page:** a "Sign in with a passkey" button above the password form when supported (§5). The browser's own passkey picker does the rest. Conditional UI (`autocomplete="username webauthn"`) on the username field.
- **Profile → Security** (beside `MFAManagement`): passkey list (nickname, created, last used, hostname), Add, Rename, Delete; the "Turn off password login" switch with the recovery-code dialog.
- **Users tab (admin):** passkey count per user; a "Passkeys" dialog with Revoke.
- `UiIcon`, CSS modules, `var(--color-*)`, strings in `public/locales/en.json`.

## 10. Tests

- Route tests on `createRouteTestApp` for every route: permission, local-only, `DISABLE_LOCAL_AUTH`, challenge single-use and expiry, counter regression, last-passkey delete refusal, last-admin confirm flow, recovery-code consume-once, login 401 parity while password login is off.
- WebAuthn verification is mocked at the `@simplewebauthn/server` boundary (a real authenticator is not available in CI); one test drives the library with a recorded fixture to catch upgrade breakage.
- Migration tests on all three backends; backup-table classification test.
- Client: hidden controls without a secure context; recovery-code dialog cannot close unacknowledged.

## 11. Mesh impact

None. No packets, notifications or timers.

## 12. Open questions for the maintainer

- **Q1.** Skip TOTP on passkey login (recommended, §7), or ask for it anyway?
- **Q2.** Is the 10-minute "recent passkey login" requirement before turning password login off acceptable, or too strict?
- **Q3.** Ship `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` as optional (derive from request when unset, recommended), or require them for passkeys to appear at all?

## 13. Delivery

One PR is too big to review well. Proposed split:

1. Schema + migration + repository + backup classification.
2. Register / login / list / rename / delete routes + login-page button + profile list.
3. Passkey-only switch, recovery codes, last-admin confirm, admin revoke.
4. Docs: `docs/` user guide page (HTTPS requirement, hostname binding, recovery).
