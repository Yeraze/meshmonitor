# Authentication Analysis Report

## 1. Executive Summary
- **Analysis Status:** Complete
- **Key Outcome:** Two critical authentication vulnerabilities were identified: (1) Missing session ID rotation after authentication enabling session fixation attacks, and (2) Missing Cache-Control headers on authentication endpoints allowing credential caching. Additionally, weak default credentials and configuration issues were found that require immediate remediation.
- **Purpose of this Document:** This report provides strategic context on the application's authentication mechanisms, dominant vulnerability patterns, and architectural details necessary to effectively exploit the vulnerabilities listed in the exploitation queue.

## 2. Dominant Vulnerability Patterns

### Pattern 1: Session Fixation Vulnerability
- **Description:** The application fails to regenerate session IDs after successful authentication at three critical points: local login, MFA verification, and OIDC callback. This allows attackers to perform session fixation attacks by forcing a known session ID on a victim before authentication, then hijacking the session after the victim logs in.
- **Implication:** Attackers can gain unauthorized access to user accounts without stealing credentials. An attacker who can set a cookie on the victim's browser (via XSS on a subdomain, network injection, or physical access) can hijack the authenticated session.
- **Representative Findings:** `AUTH-VULN-01`, `AUTH-VULN-02`, `AUTH-VULN-03`.

### Pattern 2: Missing Transport Security Headers
- **Description:** Authentication endpoints lack Cache-Control headers to prevent caching of sensitive authentication responses. Additionally, HSTS is not enabled by default, requiring explicit configuration that may be missed in deployments.
- **Implication:** Authentication responses containing session cookies and user data may be cached by browsers or intermediate proxies, allowing unauthorized access via browser history, shared computers, or proxy logs. Lack of HSTS exposes users to protocol downgrade attacks.
- **Representative Finding:** `AUTH-VULN-04`.

### Pattern 3: Weak Default Credentials
- **Description:** The application creates a default admin account with hardcoded credentials (username: "admin", password: "changeme") on first run. While this is logged to console with a warning, it represents a significant security risk if administrators fail to change it immediately.
- **Implication:** Attackers can gain full administrative access using well-known default credentials if they are not changed after initial deployment.
- **Representative Finding:** `AUTH-VULN-05`.

## 3. Strategic Intelligence for Exploitation

### Authentication Architecture
- **Primary Method:** Local username/password authentication with bcrypt hashing (10-12 salt rounds depending on code path)
- **MFA Support:** TOTP-based multi-factor authentication (otplib library) with ±30 second clock drift tolerance, 10 bcrypt-hashed backup codes
- **SSO Integration:** OpenID Connect with PKCE (S256), state/nonce validation, and signature verification via openid-client library
- **API Access:** Bearer token authentication for /api/v1/* endpoints with bcrypt-hashed tokens (12 rounds)

### Session Token Details
- **Storage:** Server-side sessions stored in database (SQLite sessions.db, PostgreSQL session table, or MySQL sessions table)
- **Cookie Name:** `meshmonitor.sid` (configurable via SESSION_COOKIE_NAME environment variable)
- **Cookie Attributes:**
  - httpOnly: true (hardcoded)
  - secure: false (default, configurable via COOKIE_SECURE)
  - sameSite: 'lax' (default, configurable via COOKIE_SAMESITE)
  - maxAge: 86400000ms (24 hours default, configurable via SESSION_MAX_AGE)
- **Session Data:** userId, username, authProvider ('local' or 'oidc'), isAdmin, csrfToken, pendingMfaUserId (during MFA flow)
- **Rolling Expiry:** Enabled by default (SESSION_ROLLING=true), resets timeout on each request

### Rate Limiting Configuration
- **Authentication Endpoints:** 5 attempts per 15 minutes (production), 100 attempts per 15 minutes (development)
- **Affected Endpoints:** POST /api/auth/login, POST /api/auth/verify-mfa
- **OIDC Endpoints:** No rate limiting on GET /api/auth/oidc/login or GET /api/auth/oidc/callback
- **Special Handling:** skipSuccessfulRequests: true (only failed attempts count toward limit)
- **Bypass:** Set RATE_LIMIT_AUTH=0 to disable (testing/development)

### Password Policy
- **Minimum Length:** 8 characters (enforced server-side)
- **Complexity Requirements:** None (no uppercase, numbers, or special characters required)
- **Storage:** bcrypt with inconsistent salt rounds (10 in some code paths, 12 in others)
- **Verification:** bcrypt.compare() with timing-safe comparison

### Default Credentials
- **Username:** admin (configurable via ADMIN_USERNAME environment variable)
- **Password:** changeme (hardcoded in /repos/meshmonitor/src/services/database.ts:8551)
- **Creation:** Automatic on first run if no admin user exists
- **Warning:** Logged to console with instructions to change immediately

### OIDC Flow Details
- **State Parameter:** 32-character cryptographically random string, validated during callback
- **Nonce Parameter:** 32-character cryptographically random string, validated in ID token
- **PKCE:** 128-character code verifier, S256 challenge method (SHA-256)
- **Redirect URI:** Configurable (OIDC_REDIRECT_URI) or auto-detected from request (vulnerable to Host header injection if misconfigured)
- **User Lookup:** Primary identifier is immutable 'sub' claim; account migration attempts match by email (account takeover risk)

### Password Reset/Recovery
- **Self-Service:** Not implemented (no token-based reset mechanism)
- **Admin Reset:** Available via POST /api/users/:id/reset-password (generates random 16-character password)
- **Script Reset:** reset-admin.mjs script for emergency admin password reset (requires shell access)
- **User Recovery:** Requires administrator intervention (no email-based reset)

## 4. Secure by Design: Validated Components

These components were analyzed and found to have robust defenses. They are low-priority for further testing.

| Component/Flow | Endpoint/File Location | Defense Mechanism Implemented | Verdict |
|---|---|---|---|
| Password Hashing | `/repos/meshmonitor/src/server/models/User.ts:23-25` | bcrypt with 12 salt rounds, timing-safe compare | SAFE |
| MFA TOTP Verification | `/repos/meshmonitor/src/server/services/mfa.ts:43-50` | otplib with ±30s tolerance, single-use backup codes | SAFE |
| API Token Generation | `/repos/meshmonitor/src/server/models/APIToken.ts:33` | crypto.randomBytes(16) with 128 bits entropy | SAFE |
| API Token Storage | `/repos/meshmonitor/src/server/models/APIToken.ts:49` | bcrypt hash with 12 salt rounds | SAFE |
| CSRF Protection | `/repos/meshmonitor/src/server/middleware/csrf.ts:73` | Double-submit cookie with constant-time comparison | SAFE |
| Login Error Messages | `/repos/meshmonitor/src/server/routes/authRoutes.ts:241-243` | Generic "Invalid username or password" for all failures | SAFE |
| Logout Session Invalidation | `/repos/meshmonitor/src/server/routes/authRoutes.ts:298` | session.destroy() properly called | SAFE |
| Session Timeout | `/repos/meshmonitor/src/server/auth/sessionConfig.ts:136` | 24-hour rolling timeout with configurable maxAge | SAFE |
| Session Cookie httpOnly | `/repos/meshmonitor/src/server/auth/sessionConfig.ts:133` | Hardcoded to true, prevents XSS cookie theft | SAFE |
| Session Cookie SameSite | `/repos/meshmonitor/src/server/auth/sessionConfig.ts:135` | Default 'lax', provides CSRF protection | SAFE |
| OIDC State Validation | `/repos/meshmonitor/src/server/auth/oidcAuth.ts:118-123` | 32-char random state, exact match validation | SAFE |
| OIDC Nonce Validation | `/repos/meshmonitor/src/server/auth/oidcAuth.ts:133` | 32-char random nonce, validated by openid-client | SAFE |
| OIDC PKCE Implementation | `/repos/meshmonitor/src/server/auth/oidcAuth.ts:89-97` | 128-char verifier, S256 challenge method (SHA-256) | SAFE |
| OIDC ID Token Signature | `/repos/meshmonitor/src/server/auth/oidcAuth.ts:127-138` | Validated by certified openid-client library (v6.8.2) | SAFE |
| OIDC User Identification | `/repos/meshmonitor/src/server/auth/oidcAuth.ts:156` | Uses immutable 'sub' claim for existing users | SAFE |
| Rate Limiting on Login | `/repos/meshmonitor/src/server/middleware/rateLimiters.ts:79-95` | 5 attempts per 15 minutes (prod), skips successful auth | SAFE |
| Audit Logging | `/repos/meshmonitor/src/server/routes/authRoutes.ts:233-239` | Failed login attempts logged with IP and username | SAFE |
