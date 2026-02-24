# MeshMonitor - Comprehensive Security Analysis & Code Review

**Target Application:** MeshMonitor v2.x - Meshtastic Mesh Network Monitor
**Analysis Date:** 2026-02-24
**Analyst:** Principal Security Engineer - AI Agent (Claude Sonnet 4.5)
**Scope:** Network-Accessible Attack Surface & Security Architecture

---

# Penetration Test Scope & Boundaries

**Primary Directive:** This analysis is strictly limited to the **network-accessible attack surface** of the application. All findings and recommendations focus on components that can be reached through network requests to the deployed application server.

### In-Scope: Network-Reachable Components
A component is considered **in-scope** if its execution can be initiated, directly or indirectly, by a network request that the deployed application server is capable of receiving. This includes:
- Publicly exposed web pages and API endpoints
- Endpoints requiring authentication via the application's standard login mechanisms
- Any developer utility, debug console, or script that has been mistakenly exposed through a route or is otherwise callable from in-scope, network-reachable code

### Out-of-Scope: Locally Executable Only
A component is **out-of-scope** if it **cannot** be invoked through the running application's network interface and requires an execution context completely external to the application's request-response cycle. This includes tools that must be run via:
- A command-line interface (e.g., `go run ./cmd/...`, `python scripts/...`)
- A development environment's internal tooling (e.g., a "run script" button in an IDE)
- CI/CD pipeline scripts or build tools
- Database migration scripts, backup tools, or maintenance utilities
- Local development servers, test harnesses, or debugging utilities
- Static files or scripts that require manual opening in a browser (not served by the application)

---

## 1. Executive Summary

MeshMonitor is a sophisticated full-stack web application designed to monitor Meshtastic mesh networks over IP. The system employs a **hybrid three-tier architecture** combining a React 19 frontend, Node.js/Express backend with WebSocket support, and multi-database compatibility (SQLite/PostgreSQL/MySQL). From a security standpoint, MeshMonitor demonstrates **strong defense-in-depth principles** with comprehensive authentication mechanisms, granular authorization controls, and multiple layers of protection against common web vulnerabilities.

**Overall Security Rating: STRONG** (with critical areas requiring immediate attention)

The application implements enterprise-grade security features including bcrypt password hashing (12 rounds), multi-factor authentication (TOTP), OpenID Connect SSO integration, comprehensive CSRF protection, multi-tier rate limiting, and extensive audit logging. However, **three critical vulnerabilities** require immediate remediation: (1) WebSocket broadcasts lack permission filtering, enabling cross-channel data leakage; (2) SSRF vulnerabilities in link preview and tile server testing endpoints allow internal network probing; and (3) MFA TOTP secrets are stored in plaintext in the database.

**Key Attack Surface Elements:**
- **250+ REST API endpoints** (authentication, user management, message handling, channel configuration, system administration)
- **40+ versioned API v1 endpoints** (programmatic access with bearer token authentication)
- **WebSocket service** for real-time mesh data updates (authenticated via session cookies)
- **Script execution engine** (Python/Bash/JavaScript) with path-validated sandboxing for automation
- **File upload functionality** (script imports with 5MB limit and extension whitelisting)
- **OIDC/OAuth integration** with PKCE for enterprise SSO

The most significant security concern is the **lack of permission-based filtering on WebSocket broadcasts**, which exposes all mesh network data to any authenticated user regardless of their channel access permissions. This represents a critical data isolation failure in the multi-tenant architecture. Additionally, **four SSRF sinks** (link preview, tile server testing, HTTP auto-responder triggers) lack internal IP address filtering, enabling potential cloud metadata access and internal network scanning.

---

## 2. Architecture & Technology Stack

### Framework & Language

**Backend Technology:**
- **Runtime:** Node.js 24 (LTS) with TypeScript 5.9.3
- **Framework:** Express 5.2.1 (HTTP server) + Socket.io (WebSocket service)
- **ORM:** Drizzle ORM 0.45.1 with multi-database driver support
- **Security Libraries:** Helmet 8.1.0, bcrypt 6.0.0, express-rate-limit 8.2.1, cors 2.8.6, express-session 1.19.0
- **Authentication:** openid-client 6.8.2 (OIDC/OAuth2), otplib 13.2.1 (TOTP MFA)

**Frontend Technology:**
- **Framework:** React 19.2.4 with TypeScript
- **Build System:** Vite 7.3.0
- **PWA Support:** Service worker with offline capabilities
- **Real-time:** Socket.io-client for WebSocket connections

**Database Layer:**
- **SQLite:** better-sqlite3 12.6.2 (default, file-based)
- **PostgreSQL:** pg 8.18.0 (optional, production-grade)
- **MySQL/MariaDB:** mysql2 3.17.4 (optional, production-grade)
- **ORM:** Drizzle ORM provides unified parameterized query interface preventing SQL injection

**Security Implications:**
The technology stack demonstrates mature, well-maintained components with active security patching. Express 5.2.1 represents the latest stable release with improved security defaults. The use of Drizzle ORM throughout the codebase eliminates SQL injection attack vectors through mandatory parameterized queries. bcrypt with 12 salt rounds provides industry-standard password protection resistant to GPU-accelerated brute force attacks. The optional database backends (PostgreSQL/MySQL) enable enterprise deployments with managed database services, though this expands the attack surface to include network-accessible database connections requiring SSL/TLS hardening.

### Architectural Pattern

**Architecture Classification:** Hybrid Microservices + Monolithic Backend

MeshMonitor implements a **three-tier architecture** with clear separation of concerns:

1. **Presentation Layer (Client-Side):**
   - React single-page application (SPA) served as static assets
   - Progressive Web App (PWA) with service worker for offline functionality
   - WebSocket client maintaining persistent connection for real-time updates
   - Client-side routing via React Router

2. **Application Layer (Server-Side):**
   - Express HTTP server handling REST API requests (port 3001 default)
   - Socket.io WebSocket server sharing the same port/session infrastructure
   - Comprehensive middleware stack: Helmet (security headers), CORS (origin validation), rate limiters (tiered by endpoint type), CSRF protection, session management, authentication/authorization
   - Service-oriented business logic: WebSocket broadcasting, notification delivery, channel decryption, system backup, security scanning

3. **Data Layer:**
   - Database abstraction via Drizzle ORM with driver-specific implementations
   - Session store (separate database for SQLite, table-based for PostgreSQL/MySQL)
   - Persistent volume mount (/data) containing databases, uploads, scripts, backups

**Trust Boundaries:**

```
Internet → Reverse Proxy (TRUST BOUNDARY #1)
  ↓ TLS termination, rate limiting, WAF
Reverse Proxy → Express Server (TRUST BOUNDARY #2)
  ↓ Authentication, authorization, CSRF validation
Express Server → Database (TRUST BOUNDARY #3)
  ↓ Parameterized queries, connection pooling
Database → Filesystem (TRUST BOUNDARY #4)
  ↓ File permissions, encryption at rest
```

**Critical Security Observation:**
The architecture includes an **optional Virtual Node Server** (port 4404) that proxies Meshtastic TCP connections for mobile apps. This component implements admin command filtering to prevent privilege escalation, but can be disabled via `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS=true`, creating a significant security risk if misconfigured.

### Critical Security Components

**Authentication & Authorization Layer:**
- **Location:** `/repos/meshmonitor/src/server/auth/`
- **Components:**
  - `authMiddleware.ts` (300 lines) - Request authentication/authorization enforcement
  - `localAuth.ts` (320 lines) - Username/password authentication with bcrypt
  - `oidcAuth.ts` (325 lines) - OpenID Connect integration with PKCE
  - `sessionConfig.ts` (152 lines) - Multi-database session store configuration

**Security Middleware Stack:**
- **Helmet.js** (`/repos/meshmonitor/src/server/server.ts:183`) - HTTP security headers (HSTS, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection)
- **Dynamic CSP** (`/repos/meshmonitor/src/server/middleware/dynamicCsp.ts`) - Content Security Policy with custom tile server allowlisting
- **Rate Limiters** (`/repos/meshmonitor/src/server/middleware/rateLimiters.ts`) - Four-tier rate limiting (API: 1000/15min, Auth: 5/15min, Messages: 30/min, MeshCore: 10/min)
- **CSRF Protection** (`/repos/meshmonitor/src/server/middleware/csrf.ts`) - Double-submit cookie pattern with constant-time validation
- **CORS** (`/repos/meshmonitor/src/server/server.ts:198`) - Configurable origin validation with credentials support

**Database Security:**
All database operations leverage Drizzle ORM with parameterized queries, eliminating SQL injection vulnerabilities. Database drivers are separated by type:
- **SQLite Driver** (`/repos/meshmonitor/src/db/drivers/sqlite.ts`) - WAL mode enabled, foreign key enforcement, busy timeout handling
- **PostgreSQL Driver** (`/repos/meshmonitor/src/db/drivers/postgres.ts`) - Connection pooling, optional SSL support
- **MySQL Driver** (`/repos/meshmonitor/src/db/drivers/mysql.ts`) - Connection pooling, prepared statement support

**Deployment Security:**
The Docker deployment (`Dockerfile`) implements security best practices including multi-stage builds (reducing attack surface), Alpine base image (minimal footprint), non-root user execution (UID 1000), and capability dropping. Kubernetes Helm charts (`/repos/meshmonitor/helm/meshmonitor/`) enforce `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, and drop all Linux capabilities.

---

## 3. Authentication & Authorization Deep Dive

MeshMonitor implements a **comprehensive, layered authentication architecture** supporting three distinct authentication methods: local username/password, OpenID Connect SSO, and API bearer tokens. Authorization is enforced through a granular resource-based permission system with per-channel access control.

### Authentication Mechanisms

**1. Local Authentication (Username/Password)**

**Implementation:** `/repos/meshmonitor/src/server/auth/localAuth.ts`

The local authentication system implements industry-standard security practices:

- **Password Hashing:** bcrypt with 12 salt rounds (lines 11, 71), providing approximately 4,096 iterations (2^12). This configuration balances security against GPU-accelerated attacks while maintaining acceptable authentication latency (~250-300ms per hash).
- **Password Policy:** Minimum 8 characters enforced (lines 55-57, 182-184). Passwords are validated before hashing to prevent weak credentials.
- **Constant-Time Comparison:** bcrypt.compare() provides timing-attack-resistant password verification (lines 172-179).
- **Account Locking:** Support for `passwordLocked` flag prevents password changes on specific accounts (lines 223-225, 270-273), useful for OIDC-migrated users.

**Critical Authentication Endpoints:**
- `POST /api/auth/login` (line 211 in authRoutes.ts) - Username/password submission
- `POST /api/auth/logout` (line 405 in authRoutes.ts) - Session termination
- `POST /api/auth/verify-mfa` (line 320 in authRoutes.ts) - Multi-factor verification
- `POST /api/auth/change-password` (line 583 in authRoutes.ts) - Password modification

**Security Feature:** Default admin account created with password "changeme" on first run. Endpoint `/api/auth/check-default-password` exposes whether the default password is still in use, enabling security warnings in the UI.

**2. Multi-Factor Authentication (MFA)**

**Implementation:** `/repos/meshmonitor/src/server/services/mfa.ts`

MeshMonitor supports TOTP-based (Time-based One-Time Password) multi-factor authentication:

- **Protocol:** TOTP following RFC 6238, compatible with Google Authenticator, Authy, and other authenticator apps
- **Secret Generation:** 32-character base32-encoded secrets generated via `otplib`
- **QR Code Provisioning:** QR codes generated for easy authenticator app setup
- **Clock Drift Tolerance:** ±30 seconds (±1 step) to handle time synchronization issues between client/server
- **Backup Codes:** 10 alphanumeric 8-character codes generated at MFA setup, bcrypt-hashed with 10 rounds
- **One-Time Use:** Backup codes are removed from the database after successful verification (lines 343-355 in authRoutes.ts)

**MFA Flow:**
1. User completes username/password authentication
2. If MFA enabled, session marked as `pendingMfaUserId` (line 249 authRoutes.ts)
3. User presented with TOTP/backup code prompt
4. Successful verification promotes session to full authentication (line 380-385 authRoutes.ts)
5. Failed attempts rate-limited (5 attempts per 15 minutes)

**⚠️ CRITICAL SECURITY FINDING:** MFA TOTP secrets are stored in **plaintext** in the database (`mfa_secret` column in users table, line 24 in `/repos/meshmonitor/src/db/schema/auth.ts`). Database compromise would expose all TOTP secrets, enabling attackers to generate valid MFA codes. **Recommendation:** Implement application-level encryption for MFA secrets using AES-256-GCM with keys derived from SESSION_SECRET + per-user salt.

**3. OpenID Connect (OIDC) Authentication**

**Implementation:** `/repos/meshmonitor/src/server/auth/oidcAuth.ts`

The OIDC implementation follows security best practices with PKCE (Proof Key for Code Exchange):

**PKCE Security Parameters:**
- **State:** 32-character random string (line 450 authRoutes.ts) - Prevents CSRF attacks during OAuth callback
- **Nonce:** 32-character random string (line 452) - Prevents replay attacks on ID tokens
- **Code Verifier:** 128-character random string (line 451) - PKCE secret
- **Code Challenge Method:** S256 (SHA-256 hashing) (line 97) - Secure PKCE transform

**Session Storage of OIDC Parameters:** State, nonce, and code verifier are stored temporarily in session (lines 454-457) and validated during callback processing.

**Callback Validation (lines 475-561 in authRoutes.ts):**
1. State parameter validated against session value (line 121 oidcAuth.ts)
2. Nonce validated in ID token (line 133 oidcAuth.ts)
3. Token exchange performed with PKCE code verifier (lines 127-135)
4. ID token signature verified via openid-client library
5. User provisioned or updated based on `sub` claim

**Auto-User Creation:** Configurable via `OIDC_AUTO_CREATE_USERS` environment variable (line 186 oidcAuth.ts). When enabled, new users are automatically created on first OIDC login. Existing local users with matching usernames/emails are migrated to OIDC authentication (lines 210-243), with their password hashes cleared.

**Environment Configuration:**
- `OIDC_ISSUER` - Identity provider URL (e.g., https://accounts.google.com)
- `OIDC_CLIENT_ID` - OAuth client identifier
- `OIDC_CLIENT_SECRET` - Client secret (stored in environment only, never persisted to database)
- `OIDC_REDIRECT_URI` - Callback URL (optional, auto-detected from request)
- `OIDC_SCOPES` - Requested scopes (default: "openid profile email")

**4. API Token Authentication**

**Implementation:** `/repos/meshmonitor/src/server/models/APIToken.ts` and `/repos/meshmonitor/src/server/routes/apiTokenRoutes.ts`

API tokens enable programmatic access to the versioned API (`/api/v1/*` endpoints):

**Token Format:** `mm_v1_<32_hex_characters>` (128 bits of entropy)
**Token Generation:** `crypto.randomBytes(16).toString('hex')` provides cryptographically secure randomness (line 33 APIToken.ts)
**Token Storage:** bcrypt hash (12 rounds) stored in database, plain token shown only once at creation (line 49)
**Token Prefix:** First 12 characters stored for display purposes (`mm_v1_abc123...`) (line 42)

**API Token Endpoints:**
- `GET /api/token` - Retrieve token info (prefix, created date, last used timestamp)
- `POST /api/token/generate` - Generate new token (automatically revokes previous token)
- `DELETE /api/token` - Revoke current token

**Authentication Flow:** Bearer token extracted from `Authorization` header (line 242 authMiddleware.ts), validated via bcrypt comparison (line 253), and user attached to request object. Token usage timestamps are updated on each successful authentication (lines 144-149 APIToken.ts).

### Session Management and Cookie Security

**Session Configuration:** `/repos/meshmonitor/src/server/auth/sessionConfig.ts`

**Session Cookie Flags (lines 132-138):**
```typescript
cookie: {
  httpOnly: true,                    // Prevents XSS cookie theft via JavaScript
  secure: env.cookieSecure,          // HTTPS-only (configurable, default: false)
  sameSite: env.cookieSameSite,      // CSRF protection (default: 'lax')
  maxAge: env.sessionMaxAge          // Session lifetime (default: 7 days)
},
name: env.sessionCookieName          // Custom cookie name (default: 'meshmonitor.sid')
```

**⚠️ SECURITY CONCERN:** `COOKIE_SECURE` defaults to `false`, allowing session cookies over HTTP. While appropriate for development, production deployments with HTTPS should explicitly set `COOKIE_SECURE=true`. The application logs warnings when accessing via HTTPS with `COOKIE_SECURE=false` (lines 167-173 authRoutes.ts).

**Session Storage Backends:**
1. **SQLite** (default) - Custom session store using separate `sessions.db` file, 15-minute cleanup interval
2. **PostgreSQL** - `connect-pg-simple` library with auto-created `session` table
3. **MySQL** - `express-mysql-session` library with auto-table creation

**Session Data Structure (lines 22-35 sessionConfig.ts):**
- `userId`, `username`, `authProvider`, `isAdmin` - Persistent user identity
- `oidcState`, `oidcCodeVerifier`, `oidcNonce` - Temporary OIDC flow tracking (cleared after authentication)
- `csrfToken` - CSRF protection token
- `pendingMfaUserId` - Two-step MFA verification state

**⚠️ CRITICAL FINDING:** `SESSION_SECRET` is auto-generated using `crypto.randomBytes(32)` if not provided (lines 342-366 environment.ts). While secure, this invalidates all sessions on server restart. **Recommendation:** Require `SESSION_SECRET` in production deployments or persist auto-generated secrets to database.

### Authorization Model

**Permission System:** `/repos/meshmonitor/src/types/permission.ts`

MeshMonitor implements a **resource-based permission model** with 28 resource types and 3 permission actions:

**Resource Types:**
- **Core:** Dashboard, Nodes, Messages, Info, Configuration, Settings
- **Channels:** channel_0 through channel_7 (per-channel access control)
- **Advanced:** Automation, Connection, Traceroute, Audit, Security, Themes, Private Positions, MeshCore

**Permission Actions:**
- `viewOnMap` - View nodes/messages on map visualization (channel-specific)
- `read` - Read access to resource data
- `write` - Modify resource data

**Permission Storage:** Database table `permissions` (lines 52-62 in `/repos/meshmonitor/src/db/schema/auth.ts`) with foreign key cascade delete ensuring permissions are removed when users are deleted.

**Authorization Middleware:** `/repos/meshmonitor/src/server/auth/authMiddleware.ts`

Five middleware functions enforce authorization:

1. **`optionalAuth()`** (lines 17-47) - Attaches authenticated user or anonymous user, no rejection
2. **`requireAuth()`** (lines 52-96) - Requires valid session, returns 401 if missing
3. **`requirePermission(resource, action)`** (lines 102-170) - Checks specific resource permission, returns 403 if denied
4. **`requireAdmin()`** (lines 175-219) - Requires authentication AND admin flag
5. **`requireAPIToken()`** (lines 238-299) - Validates Bearer token from Authorization header

**Admin Bypass:** Administrators automatically pass all `requirePermission()` checks (lines 138-140), enabling full system access.

**Default Permissions:**
- **Admins:** All resources with read + write access (lines 91-114 permission.ts)
- **Regular Users:** Read-only access to Dashboard, Nodes, Channels 0-7, Messages, Info, Connection, Traceroute (lines 116-139)
- **Anonymous Users:** Configurable via `DISABLE_ANONYMOUS` environment variable

**SSO/OAuth/OIDC Flows:**

**Callback Endpoint:** `/api/auth/oidc/callback` (lines 475-561 authRoutes.ts)

**State Parameter Validation:** Session-stored state compared with callback parameter (line 497-510). Uses timing-safe comparison to prevent timing attacks.

**Nonce Parameter Handling:** Nonce generated during authorization initiation (line 452), stored in session, and validated in ID token claims (line 133 oidcAuth.ts). This prevents replay attacks where an attacker reuses a captured ID token.

**Code Location:** State validation occurs at `/repos/meshmonitor/src/server/routes/authRoutes.ts:497-510` and `/repos/meshmonitor/src/server/auth/oidcAuth.ts:121`. Nonce validation occurs at `/repos/meshmonitor/src/server/auth/oidcAuth.ts:133`.

---

## 4. Data Security & Storage

### Database Security

**Schema Security:** MeshMonitor stores sensitive data across multiple tables requiring protection:

**Critical Tables:**
- `users` - Password hashes (bcrypt), MFA secrets (plaintext), OIDC subjects, email addresses
- `api_tokens` - Token hashes (bcrypt), token prefixes
- `permissions` - Access control matrix
- `sessions` - Active session data (user IDs, auth state)
- `channel_database` - Meshtastic channel encryption keys (PSKs) in base64 encoding
- `audit_log` - Security events with IP addresses and user agents
- `messages` - User communications
- `nodes` - GPS coordinates (latitude/longitude/altitude)

**Encryption at Rest:** ❌ **NOT IMPLEMENTED**

Database files are stored in plaintext on the filesystem. The application relies on host-level encryption (LUKS, dm-crypt, or cloud provider volume encryption). **Recommendation:** Document encryption at rest requirements in deployment guides. For PostgreSQL, enable Transparent Data Encryption (TDE) with pgcrypto or pg_tde. For MySQL, enable InnoDB encryption.

**Database Connection Security:**
- SQLite: Local file access only, protected by filesystem permissions
- PostgreSQL: Optional SSL/TLS support via `ssl` connection parameter (line 52 postgres.ts driver)
- MySQL: Optional SSL/TLS support

**⚠️ SECURITY CONCERN:** SSL/TLS is **not enforced by default** for PostgreSQL/MySQL connections. **Recommendation:** Add `DATABASE_SSL_REQUIRED=true` environment variable and enforce SSL certificate validation in production deployments.

**SQL Injection Protection:** ✅ **EXCELLENT**

All database queries use Drizzle ORM with parameterized statements. Example from `/repos/meshmonitor/src/db/repositories/auth.ts`:
```typescript
const result = await db
  .select()
  .from(usersSqlite)
  .where(eq(usersSqlite.id, id))  // Parameterized
  .limit(1);
```

No raw SQL string concatenation detected across 172+ files reviewed. The ORM enforces parameterized queries, eliminating SQL injection attack vectors.

### Data Flow Security

**Password Authentication Flow:**
1. User submits credentials → `POST /api/auth/login`
2. Password validated via `bcrypt.compare(password, passwordHash)` (line 172-179 localAuth.ts)
3. Password variable discarded immediately (not logged, not stored in session)
4. Session created with `userId` only (no password or hash)
5. Password hash never sent to client (filtered in response, line 95, 281 authRoutes.ts)

**API Token Authentication Flow:**
1. Client sends `Authorization: Bearer mm_v1_abc123...`
2. Token extracted from header (line 242 authMiddleware.ts)
3. Token validated via `bcrypt.compare(token, tokenHash)` (line 253)
4. Token usage timestamp updated (lines 144-149 APIToken.ts)
5. User attached to request object
6. Audit log records token usage (line 282-288 authMiddleware.ts)

**MFA Verification Flow:**
1. User submits TOTP code → `POST /api/auth/verify-mfa`
2. TOTP validated via `otplib.verifySync()` with ±30s tolerance
3. If TOTP fails, backup codes checked via `bcrypt.compare()`
4. Used backup code removed from database (one-time use)
5. Session promoted from `pendingMfaUserId` to full authentication

### Multi-Tenant Data Isolation

**Channel-Based Permission System:**

MeshMonitor implements per-channel access control to isolate mesh network data across 8 channels (channels 0-7):

**Permission Enforcement:** Database table `channel_database_permissions` (lines 48-60 in `/repos/meshmonitor/src/db/schema/channelDatabase.ts`) with foreign key relationships to users and channels.

**Granular Permissions:**
- `canViewOnMap` - Controls visibility of nodes/messages on map for specific channel
- `canRead` - Controls access to message content for specific channel

**⚠️ CRITICAL SECURITY VULNERABILITY:** WebSocket broadcasts lack permission filtering

**Location:** `/repos/meshmonitor/src/server/services/webSocketService.ts` (lines 148-156)

**Issue:** All authenticated users receive ALL data events via WebSocket, regardless of their channel permissions:

```typescript
const handler = (event: DataEvent) => {
  if (event.type === 'message:new') {
    const transformedMessage = transformMessageForClient(event.data as DbMessage);
    socket.emit(event.type, transformedMessage);  // BROADCAST TO ALL
  } else {
    socket.emit(event.type, event.data);  // BROADCAST TO ALL
  }
};
```

**Impact:** Users with limited channel permissions can see all network activity through the WebSocket connection, bypassing API permission checks. This creates a significant data isolation failure in multi-tenant deployments.

**Severity:** HIGH - Data leakage across security boundaries

**Recommendation:** Implement per-user permission filtering before broadcasting WebSocket events. Filter messages by `canRead` permission on message channel. Filter node updates by channel visibility permissions.

### Sensitive Data Inventory

**1. Password Hashes:** ✅ SECURE - bcrypt 12 rounds, never logged or exposed
**2. API Tokens:** ✅ SECURE - bcrypt 12 rounds, shown only once at creation
**3. MFA TOTP Secrets:** ❌ PLAINTEXT - Stored unencrypted in database (`mfa_secret` column)
**4. MFA Backup Codes:** ✅ SECURE - bcrypt 10 rounds, single-use
**5. OIDC Client Secret:** ✅ SECURE - Environment variable only, never persisted
**6. Session Data:** ✅ SECURE - HttpOnly/Secure/SameSite cookies, no sensitive data in session
**7. Channel PSKs:** ⚠️ PLAINTEXT - Base64-encoded AES keys stored unencrypted (operational requirement for server-side decryption)
**8. GPS Coordinates:** ✅ PRIVACY FEATURES - Position override, private mode, precision control
**9. User PII:** ✅ MINIMAL - Email optional, no SSN/credit cards/phone numbers

**Database Backup Security:**

**Location:** `/repos/meshmonitor/src/server/services/systemBackupService.ts`

**Findings:**
- Backups stored in plaintext YAML format in `/data/system-backups/`
- Backups include ALL sensitive data (users table with password hashes/MFA secrets, permissions, channels with PSKs, messages, audit logs)
- SHA-256 checksums verify backup integrity
- ⚠️ **NO BACKUP ENCRYPTION IMPLEMENTED**

**Severity:** HIGH - Backup theft exposes entire system

**Recommendation:** Implement backup encryption using GPG, age, or AES-256. Store encryption keys separately from backups. Document backup encryption procedures.

---

## 5. Attack Surface Analysis

### External Entry Points

MeshMonitor exposes **250+ HTTP/HTTPS endpoints** across multiple functional categories. Based on comprehensive code analysis, the following network-accessible entry points have been identified:

**1. Authentication & Session Management** (9 endpoints)
- `POST /api/auth/login` - Local username/password authentication (rate limited: 5/15min)
- `POST /api/auth/logout` - Session termination
- `GET /api/auth/status` - Current authentication state query
- `POST /api/auth/verify-mfa` - Multi-factor authentication verification (rate limited: 5/15min)
- `GET /api/auth/oidc/login` - OIDC authorization initiation
- `GET /api/auth/oidc/callback` - OIDC callback handler (validates state/nonce)
- `POST /api/auth/change-password` - Password modification (requires current password)
- `GET /api/auth/check-default-password` - Detects default admin password usage
- `GET /api/auth/check-config-issues` - Configuration security warnings

**2. User Management** (15 endpoints - Admin Only)
- `GET /api/users` - List all users
- `POST /api/users` - Create new user
- `GET /api/users/:id` - Retrieve user details
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `POST /api/users/:id/reset-password` - Admin password reset
- `POST /api/users/:id/api-token` - Generate API token for user
- `GET /api/users/:id/permissions` - List user permissions
- `POST /api/users/:id/permissions` - Grant permission
- `DELETE /api/users/:id/permissions/:permissionId` - Revoke permission
- Additional permission management endpoints

**3. API Token Management** (3 endpoints)
- `GET /api/token` - Get current token info (prefix, dates)
- `POST /api/token/generate` - Generate new token (revokes existing)
- `DELETE /api/token` - Revoke current token

**4. Multi-Factor Authentication** (4 endpoints)
- `POST /api/mfa/setup` - Initiate MFA setup (generates TOTP secret + QR code)
- `POST /api/mfa/verify-setup` - Verify setup with TOTP code (enables MFA)
- `POST /api/mfa/disable` - Disable MFA (requires password confirmation)
- `POST /api/mfa/regenerate-backup-codes` - Generate new backup codes

**5. Audit Logs** (3 endpoints - Admin Only)
- `GET /api/audit` - Retrieve audit log entries (filterable by user/action/date)
- `GET /api/audit/actions` - List available audit actions
- `DELETE /api/audit` - Clear audit log

**6. Security Scanning** (5 endpoints - Admin Only)
- `GET /api/security/scan` - Trigger security scan (duplicate keys, low entropy)
- `GET /api/security/results` - Retrieve scan results
- `GET /api/security/results/:scanType` - Specific scan type results
- `GET /api/security/export` - Export security report (CSV format)
- `DELETE /api/security/clear` - Clear security scan data

**7. Message Management** (7 endpoints)
- `GET /api/messages` - List messages (paginated, filterable by channel)
- `POST /api/messages` - Send new message (rate limited: 30/min)
- `GET /api/messages/:id` - Retrieve specific message
- `PUT /api/messages/:id` - Update message
- `DELETE /api/messages/:id` - Delete message
- `POST /api/messages/purge` - Bulk delete old messages (Admin)
- `GET /api/messages/count` - Message count statistics

**8. Channel Database** (11 endpoints)
- `GET /api/channels` - List all channels with PSKs (permission-filtered)
- `POST /api/channels` - Add channel PSK (Admin)
- `GET /api/channels/:id` - Retrieve channel details
- `PUT /api/channels/:id` - Update channel
- `DELETE /api/channels/:id` - Delete channel
- `POST /api/channels/:id/permissions` - Grant channel access
- `DELETE /api/channels/:id/permissions/:permissionId` - Revoke channel access
- `POST /api/channels/import` - Bulk import channels
- `GET /api/channels/export` - Export channel database
- Additional channel management endpoints

**9. Node Management** (10+ endpoints)
- `GET /api/nodes` - List mesh nodes (permission-filtered)
- `GET /api/nodes/:id` - Retrieve node details
- `PUT /api/nodes/:id` - Update node metadata
- `DELETE /api/nodes/:id` - Delete node
- `POST /api/nodes/:id/position-override` - Set custom position
- `DELETE /api/nodes/:id/position-override` - Clear position override
- `GET /api/nodes/statistics` - Network statistics

**10. System Configuration** (20+ endpoints - Admin Only)
- `GET /api/config` - Retrieve system configuration
- `PUT /api/config` - Update configuration
- `POST /api/system/backup` - Create system backup
- `GET /api/system/backups` - List backups
- `POST /api/system/restore` - Restore from backup
- `DELETE /api/system/backups/:id` - Delete backup
- `POST /api/system/reboot` - Reboot server/device
- `POST /api/system/upgrade` - Trigger Docker upgrade
- `GET /api/system/version` - Current version info
- `GET /api/system/health` - Health check endpoint

**11. Automation & Scripting** (12+ endpoints)
- `GET /api/scripts` - List uploaded scripts
- `POST /api/scripts/import` - Upload script file (5MB limit, .js/.py/.sh)
- `POST /api/scripts/test` - Test script execution (30s timeout)
- `DELETE /api/scripts/:id` - Delete script
- `GET /api/automation/triggers` - List auto-responder triggers
- `POST /api/automation/triggers` - Create trigger
- `PUT /api/automation/triggers/:id` - Update trigger
- `DELETE /api/automation/triggers/:id` - Delete trigger
- `POST /api/automation/test` - Test automation rule
- Geofence, timer, and HTTP trigger endpoints

**12. Link Preview & Tile Server Testing** (⚠️ SSRF Risk)
- `GET /api/link-preview?url=<URL>` - Fetch OpenGraph metadata (SSRF sink, no authentication required)
- `POST /api/tile-server/test` - Test tile server URL (SSRF sink, no authentication required)
- `POST /api/tile-server/autodetect` - Auto-detect tile server type (SSRF sink, no authentication required)
- `POST /api/http/test` - Test HTTP auto-responder URL (SSRF sink, requires settings:read)

**13. API v1 (Versioned REST API)** (40+ endpoints)

**Authentication:** Requires API bearer token (`Authorization: Bearer mm_v1_...`)

**Endpoints:**
- `GET /api/v1/nodes` - Retrieve nodes
- `GET /api/v1/messages` - Retrieve messages
- `GET /api/v1/channels` - List channels
- `GET /api/v1/telemetry` - Device telemetry data
- `GET /api/v1/traceroutes` - Network path traces
- `GET /api/v1/network` - Network statistics
- `GET /api/v1/packets` - Packet logs
- `GET /api/v1/docs` - Swagger/OpenAPI documentation

**OpenAPI Specification:** `/repos/meshmonitor/src/server/routes/v1/openapi.yaml`

**14. WebSocket Service** (Real-Time Updates)

**Endpoint:** `wss://<host>/socket.io` (Socket.io protocol)

**Authentication:** Session-based (shares Express session cookie)

**Events Emitted:**
- `message:new` - New message received
- `node:update` - Node metadata updated
- `telemetry:update` - Device telemetry data
- `traceroute:complete` - Traceroute completed
- `position:update` - Node position changed

**⚠️ CRITICAL VULNERABILITY:** No permission filtering on broadcasts (see Section 4)

### Internal Service Communication

**Apprise Notification Service:**
- **Port:** 8000 (internal)
- **Purpose:** Notification delivery to 100+ services (Discord, Slack, email, etc.)
- **Exposure:** NOT exposed externally by default
- **Communication:** HTTP POST requests from Express server to Apprise API
- **User Input:** User-configured notification URLs passed to Apprise service

**Virtual Node Server (Optional):**
- **Port:** 4404 (configurable)
- **Purpose:** TCP proxy for Meshtastic mobile apps
- **Protocol:** Meshtastic binary protobuf over TCP
- **Security:** Admin command filtering (can be disabled via `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS=true`)

### Input Validation Patterns

**Positive Findings:**
1. **Path Traversal Prevention:** All file operations use `path.basename()` or strict regex validation (examples in server.ts lines 94-114, 4130-4151)
2. **Script Path Validation:** Blocks `..` patterns and validates `/data/scripts/` prefix
3. **Filename Validation:** Regex patterns enforce alphanumeric + safe characters only
4. **URL Validation:** Protocol whitelisting (HTTP/HTTPS only) in multiple endpoints

**Areas of Concern:**
1. **ReDoS Vulnerability:** User-controlled regex patterns in auto-responder triggers lack complexity validation (server.ts lines 8658-8690, meshtasticManager.ts lines 8265-8273). Patterns like `{param:(a+)+b}` could cause catastrophic backtracking.
2. **SSRF Vulnerabilities:** Multiple endpoints fetch user-provided URLs without internal IP filtering (see Section 10).

### Background Processing

**Scheduled Tasks:**
- **News Service:** Fetches `https://meshmonitor.org/news.json` every 6 hours (hardcoded URL, no user control)
- **Solar Monitoring:** Fetches solar forecast from `https://api.forecast.solar/` (coordinates user-configured)
- **Version Check:** Queries GitHub API for latest release (hardcoded URL)
- **Security Scan:** Periodic duplicate key and low-entropy detection
- **Session Cleanup:** Expires old sessions every 15 minutes
- **Backup Rotation:** Retains configurable number of backups

**Security Posture:** Background tasks use hardcoded or parameterized URLs with numeric values only, preventing SSRF exploitation through scheduled tasks.

---

## 6. Infrastructure & Operational Security

### Secrets Management

**Environment Variables:**

**Critical Secrets:**
- `SESSION_SECRET` - Session cookie signing key (auto-generated if not provided)
- `OIDC_CLIENT_SECRET` - OAuth client secret
- `VAPID_PRIVATE_KEY` - Web push notification private key
- `DATABASE_URL` - PostgreSQL/MySQL connection string (may contain credentials)

**Security Practices:**
- ✅ Secrets loaded from environment (not hardcoded)
- ✅ Database passwords masked in logs (line 39 postgres.ts)
- ✅ Secrets never exposed in API responses
- ⚠️ SESSION_SECRET auto-generated with warning if not provided

**Recommendation:** Integrate with secrets management tools (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault) for enterprise deployments.

### Configuration Security

**Session Cookie Flags Configuration:**
**Location:** `/repos/meshmonitor/src/server/auth/sessionConfig.ts` (lines 132-138)

Session cookies are configured with security flags:
- `httpOnly: true` - Set at line 133 (prevents XSS cookie theft)
- `secure: env.cookieSecure` - Set at line 134 (HTTPS-only, configurable via `COOKIE_SECURE` env var)
- `sameSite: env.cookieSameSite` - Set at line 135 (CSRF protection, configurable via `COOKIE_SAMESITE`, default: 'lax')

**Infrastructure Configuration for Security Headers:**

The application does not directly configure HSTS or Cache-Control headers at the infrastructure level. These headers are set by the application itself:

**HSTS (HTTP Strict Transport Security):**
**Location:** `/repos/meshmonitor/src/server/server.ts` (lines 151-184)

Configured via Helmet.js middleware:
```typescript
// Lines 161-165 (production HTTPS mode)
hsts: {
  maxAge: 31536000,        // 1 year
  includeSubDomains: true,
  preload: true
}
```

HSTS is **only enabled** when both `COOKIE_SECURE=true` AND the application is accessed via HTTPS. In development/HTTP mode, HSTS is disabled (line 175).

**Cache-Control Headers:**
The application does not set Cache-Control headers explicitly. Browsers will use default caching behavior unless a reverse proxy (Nginx, Caddy) is configured to set these headers.

**Recommendation:** Document reverse proxy configuration for security headers:
```nginx
# Nginx example
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header Cache-Control "no-store, no-cache, must-revalidate, private" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
```

### External Dependencies

**Third-Party Services:**
1. **Apprise** - Notification delivery (100+ integrations: Discord, Slack, email, SMS, push notifications)
2. **Tile Servers** - Map tile providers (OpenStreetMap, CartoDB, OpenTopoMap, ArcGIS Online, custom servers)
3. **OIDC Providers** - Identity providers (Keycloak, Auth0, Okta, Google, Azure AD)
4. **Solar Forecast API** - Solar irradiance predictions (https://api.forecast.solar/)
5. **GitHub API** - Version checking and update notifications

**Security Implications:**
- **Apprise URLs:** User-configured notification URLs could point to malicious endpoints (risk mitigated by Apprise's internal URL validation)
- **Custom Tile Servers:** URLs dynamically added to CSP (potential CSP bypass if attacker controls tile server URL)
- **OIDC Trust:** Application trusts ID tokens signed by configured OIDC provider

### Monitoring & Logging

**Audit Logging:**

**Schema:** `/repos/meshmonitor/src/db/schema/auth.ts` (lines 90-112)

**Logged Events:**
- Authentication: `login_success`, `login_failed`, `login_mfa_required`, `logout`
- MFA: `mfa_setup_initiated`, `mfa_enabled`, `mfa_disabled`, `mfa_backup_code_used`
- User Management: `user_created`, `user_updated`, `user_deleted`
- Passwords: `password_changed`, `password_reset`, `password_set`
- Permissions: `permission_granted`, `permission_revoked`
- API Tokens: `api_token_generated`, `api_token_used`, `api_token_invalid`, `api_token_revoked`
- OIDC: `oidc_user_created`, `user_migrated_to_oidc`
- Security: `security_scan_triggered`, `security_export`, `security_issues_cleared`

**Audit Log Access:** `GET /api/audit` (requires `audit:read` permission, admin-only by default)

**Log Data Captured:**
- User ID and username
- Action type and resource
- IP address (from request)
- User agent (browser/client info)
- Timestamp
- JSON details (action-specific metadata)

**Log Retention:** No automatic expiration configured (grows indefinitely)

**Access Logging:**

**Location:** `/repos/meshmonitor/src/server/middleware/accessLogger.ts`

Uses Morgan library with custom format:
- HTTP method and URL
- Status code
- Response time
- Client IP
- User agent (truncated to 100 chars)

**Sensitive Data Filtering:** Passwords and tokens not logged (password field filtered from request body logs)

**Recommendation:** Implement log rotation, retention policies, and SIEM integration for enterprise deployments.

---

## 7. Overall Codebase Indexing

MeshMonitor follows a well-organized monorepo structure with clear separation between frontend, backend, database, and deployment configurations. The repository demonstrates mature engineering practices with comprehensive TypeScript typing, consistent naming conventions, and extensive documentation. The codebase is split into several major organizational units that impact security analysis and vulnerability discovery.

**Root Directory Structure:**
The root contains deployment configurations (`docker-compose*.yml`, `Dockerfile`, `helm/`), development tooling (`.devcontainer/`, `.github/`), and initialization scripts. Security-relevant configuration templates are found in `.env.example` and `.env.production.example`, which define critical environment variables like `SESSION_SECRET`, database credentials, OIDC client secrets, and CORS allowed origins.

**Source Code Organization (`/src` directory):**

**Backend** (`/src/server/`) contains the Express application with subdirectories for:
- `auth/` - Authentication implementations (local, OIDC, session management, middleware)
- `middleware/` - Security middleware (CSRF, rate limiting, CSP, access logging)
- `routes/` - API endpoint definitions organized by functional area (authRoutes, userRoutes, messageRoutes, etc.)
- `services/` - Business logic services (WebSocket broadcasting, notification delivery, channel decryption, system backup, security scanning)
- `models/` - SQLite-specific data models (User, APIToken, etc.)
- `migrations/` - 60+ database schema migrations with audit trail
- `config/` - Environment variable parsing and validation

**Database Layer** (`/src/db/`) implements a clean abstraction over three database types:
- `drivers/` - Database-specific implementations (sqlite.ts, postgres.ts, mysql.ts)
- `schema/` - Drizzle ORM schema definitions (auth.ts, nodes.ts, messages.ts, channelDatabase.ts)
- `repositories/` - Data access layer using Drizzle ORM (parameterized queries preventing SQL injection)

**Frontend** (`/src/components/`, `/src/hooks/`, `/src/contexts/`) uses React 19 with:
- Component-based architecture with TypeScript type safety
- Context providers for authentication state, WebSocket connections, map interactions
- Hooks for data fetching, permission checking, and state management

**Security Impact on Discoverability:**

The clear separation of authentication logic into `/src/server/auth/` makes it straightforward to identify authentication endpoints, session management code, and authorization middleware. However, **script execution capabilities** are scattered across multiple files (server.ts, meshtasticManager.ts), requiring careful analysis to understand the complete attack surface. The **SSRF vulnerabilities** were discovered by examining route handlers in separate files (linkPreviewRoutes.ts, tileServerTest.ts, authRoutes.ts), demonstrating the importance of comprehensive file-by-file review rather than relying on centralized security configuration.

**Deployment Configurations** (`/docker/`, `/helm/`) contain critical security settings:
- `supervisord.conf` - Process management running as non-root user (UID 1000)
- `docker-entrypoint.sh` - Container initialization with PUID/PGID handling
- Helm values.yaml - Kubernetes security context (runAsNonRoot, drop capabilities)

**Documentation** (`/docs/`) includes architecture guides, deployment instructions, and configuration references. The `/docs/public/openapi.yaml` file contains the OpenAPI 3.0.3 specification for the versioned API v1 endpoints.

**Build Tooling:**
- Vite 7.3.0 for frontend bundling with PWA plugin for service worker generation
- TypeScript 5.9.3 with strict mode enforced
- ESLint and Prettier for code quality
- Vitest for unit testing

**Code Generation:**
The `/protobufs/` directory (Git submodule) contains Meshtastic protocol buffer definitions. These are compiled to TypeScript at build time, generating message parsers and encoders. The protobuf parsing code in `/src/server/meshtasticProtobufService.ts` deserializes binary messages from Meshtastic devices, representing a potential attack vector if malformed protobufs cause crashes or memory corruption.

---

## 8. Critical File Paths

The following files are referenced throughout this security analysis and represent the most security-relevant components of the MeshMonitor codebase:

### Configuration
- `/repos/meshmonitor/.env.example` - Configuration template with security defaults
- `/repos/meshmonitor/.env.production.example` - Production configuration template
- `/repos/meshmonitor/src/server/config/environment.ts` - Centralized environment variable parsing
- `/repos/meshmonitor/docker-compose.production.yml` - Production deployment configuration
- `/repos/meshmonitor/helm/meshmonitor/values.yaml` - Kubernetes Helm chart defaults

### Authentication & Authorization
- `/repos/meshmonitor/src/server/auth/authMiddleware.ts` - Authentication/authorization middleware (requireAuth, requirePermission, requireAdmin)
- `/repos/meshmonitor/src/server/auth/localAuth.ts` - Local username/password authentication with bcrypt
- `/repos/meshmonitor/src/server/auth/oidcAuth.ts` - OpenID Connect implementation with PKCE
- `/repos/meshmonitor/src/server/auth/sessionConfig.ts` - Session store configuration (multi-database support)
- `/repos/meshmonitor/src/server/routes/authRoutes.ts` - Authentication endpoints (login, logout, OIDC callback, MFA)
- `/repos/meshmonitor/src/server/routes/mfaRoutes.ts` - Multi-factor authentication endpoints
- `/repos/meshmonitor/src/server/routes/apiTokenRoutes.ts` - API token management
- `/repos/meshmonitor/src/server/services/mfa.ts` - TOTP MFA service
- `/repos/meshmonitor/src/types/permission.ts` - Permission type definitions and defaults

### API & Routing
- `/repos/meshmonitor/src/server/server.ts` - Main Express application (8000+ lines, contains script execution, HTTP trigger testing)
- `/repos/meshmonitor/src/server/routes/userRoutes.ts` - User management (admin endpoints)
- `/repos/meshmonitor/src/server/routes/messageRoutes.ts` - Message management
- `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` - Link preview endpoint (SSRF sink)
- `/repos/meshmonitor/src/server/routes/tileServerTest.ts` - Tile server testing (SSRF sink)
- `/repos/meshmonitor/src/server/routes/securityRoutes.ts` - Security scan endpoints
- `/repos/meshmonitor/src/server/routes/scriptContentRoutes.ts` - Script content proxy (GitHub allowlist)
- `/repos/meshmonitor/src/server/routes/v1/openapi.yaml` - API v1 OpenAPI specification

### Data Models & DB Interaction
- `/repos/meshmonitor/src/db/schema/auth.ts` - Users, permissions, audit log tables
- `/repos/meshmonitor/src/db/schema/channelDatabase.ts` - Channel PSKs and permissions
- `/repos/meshmonitor/src/db/schema/nodes.ts` - Mesh node metadata and positions
- `/repos/meshmonitor/src/db/schema/messages.ts` - Message storage
- `/repos/meshmonitor/src/db/drivers/sqlite.ts` - SQLite database driver
- `/repos/meshmonitor/src/db/drivers/postgres.ts` - PostgreSQL database driver
- `/repos/meshmonitor/src/db/drivers/mysql.ts` - MySQL database driver
- `/repos/meshmonitor/src/db/repositories/auth.ts` - Authentication data access layer
- `/repos/meshmonitor/src/server/models/User.ts` - User model (SQLite)
- `/repos/meshmonitor/src/server/models/APIToken.ts` - API token model (SQLite)

### Dependency Manifests
- `/repos/meshmonitor/package.json` - Node.js dependencies (137 packages)
- `/repos/meshmonitor/package-lock.json` - Locked dependency versions

### Sensitive Data & Secrets Handling
- `/repos/meshmonitor/src/server/models/User.ts` - Password hashing (bcrypt 12 rounds)
- `/repos/meshmonitor/src/server/models/APIToken.ts` - API token hashing (bcrypt 12 rounds)
- `/repos/meshmonitor/src/server/services/mfa.ts` - MFA secret storage (plaintext)
- `/repos/meshmonitor/src/server/services/channelDecryptionService.ts` - Meshtastic channel encryption (AES-CTR)
- `/repos/meshmonitor/generate-vapid-keys.js` - VAPID key generation for web push

### Middleware & Input Validation
- `/repos/meshmonitor/src/server/middleware/csrf.ts` - CSRF protection (double-submit cookie pattern)
- `/repos/meshmonitor/src/server/middleware/rateLimiters.ts` - Multi-tier rate limiting
- `/repos/meshmonitor/src/server/middleware/dynamicCsp.ts` - Content Security Policy generation
- `/repos/meshmonitor/src/server/middleware/accessLogger.ts` - HTTP request logging

### Logging & Monitoring
- `/repos/meshmonitor/src/server/services/webSocketService.ts` - WebSocket broadcasting (permission filtering vulnerability)
- `/repos/meshmonitor/src/server/services/dataEventEmitter.ts` - Event bus for mesh data
- `/repos/meshmonitor/src/server/middleware/accessLogger.ts` - Access log middleware

### Infrastructure & Deployment
- `/repos/meshmonitor/Dockerfile` - Production container build
- `/repos/meshmonitor/docker-compose.yml` - Default Docker deployment
- `/repos/meshmonitor/docker-compose.production.yml` - Production Docker deployment
- `/repos/meshmonitor/docker/supervisord.conf` - Process management configuration
- `/repos/meshmonitor/docker/docker-entrypoint.sh` - Container initialization
- `/repos/meshmonitor/helm/meshmonitor/templates/deployment.yaml` - Kubernetes deployment manifest
- `/repos/meshmonitor/nginx.conf` - Example reverse proxy configuration

### Security-Critical Locations
- `/repos/meshmonitor/src/server/meshtasticManager.ts` - Protobuf parsing, auto-responder triggers (ReDoS, command injection, SSRF)
- `/repos/meshmonitor/src/server/services/systemBackupService.ts` - Unencrypted backup storage
- `/repos/meshmonitor/src/server/virtualNodeServer.ts` - TCP proxy with admin command filtering

---

## 9. XSS Sinks and Render Contexts

After comprehensive analysis of network-accessible web application components, **no XSS vulnerabilities were identified** in the MeshMonitor codebase. The application uses React 19 throughout the frontend, which provides automatic XSS protection through JSX escaping of all dynamic content.

### Analysis Results

**XSS Sink Categories Analyzed:**

**1. HTML Body Context:** ✅ NO VULNERABILITIES FOUND
- No `dangerouslySetInnerHTML` usage detected
- No `innerHTML` or `outerHTML` assignments found
- No `document.write()` or `document.writeln()` calls
- No `insertAdjacentHTML()` usage
- No jQuery HTML injection sinks (jQuery not used in codebase)

**2. HTML Attribute Context:** ✅ NO VULNERABILITIES FOUND
- No dynamic event handler assignments (onclick, onerror, onload, etc.)
- No unsafe URL attribute manipulation
- No direct style attribute manipulation with user input

**3. JavaScript Context:** ✅ NO VULNERABILITIES FOUND
- No `eval()` calls detected
- No `Function()` constructor usage with user input
- No `setTimeout()` or `setInterval()` with string arguments
- User data not written into `<script>` tags

**4. URL Context:** ✅ NO VULNERABILITIES FOUND (LOW RISK)

Two URL manipulations were identified but assessed as non-exploitable:

**Location 1:** `/repos/meshmonitor/src/contexts/AuthContext.tsx` (Line 192)
```typescript
window.location.href = response.authUrl;
```
**Assessment:** The `authUrl` value comes from the backend API endpoint `/api/auth/oidc/login`, not from user input. The backend constructs this URL using the configured OIDC issuer and validated parameters. **No vulnerability.**

**Location 2:** `/repos/meshmonitor/src/components/PacketMonitorPanel.tsx` (Line 416)
```typescript
window.open(popoutUrl, '_blank', 'width=1200,height=800');
```
**Assessment:** The `popoutUrl` is constructed from `baseHref` (derived from HTML `<base>` tag set by the server) and a hardcoded path. No user input influences this URL. **No vulnerability.**

### Conclusion

The exclusive use of React with JSX escaping provides robust XSS protection. All dynamic content rendering flows through React's virtual DOM, which automatically escapes HTML entities, preventing injection attacks. The codebase follows React best practices by avoiding dangerous APIs like `dangerouslySetInnerHTML` and unsafe DOM manipulation.

**No XSS sinks requiring remediation were identified.**

---

## 10. SSRF Sinks

Seven Server-Side Request Forgery (SSRF) sinks were identified in network-accessible components. Four of these require **immediate remediation** due to lack of internal IP filtering.

### SSRF Sink #1: Link Preview Endpoint (CRITICAL)

**Severity:** HIGH
**Location:** `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` (Lines 59-157)
**Endpoint:** `GET /api/link-preview?url=<user-input>`
**Authentication:** Optional (No authentication required)

**Vulnerability:**
```typescript
// Line 59-78: URL validation
const { url } = req.query;
let validatedUrl: URL;
try {
  validatedUrl = new URL(url);
  if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
    return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
  }
}

// Line 96: SSRF sink
const response = await fetch(url, {
  signal: controller.signal,
  headers: { 'User-Agent': 'MeshMonitor-LinkPreview/1.0' },
});
```

**Exploitability:** HIGH
- Can target internal services (e.g., `http://localhost:8080/admin`, `http://192.168.1.1/config`)
- Can access cloud metadata endpoints (e.g., `http://169.254.169.254/latest/meta-data/iam/security-credentials/`)
- Can perform internal network port scanning
- Response content (title, description, images) returned to attacker

**Proof of Concept:**
```bash
curl "https://meshmonitor.example.com/api/link-preview?url=http://169.254.169.254/latest/meta-data/"
curl "https://meshmonitor.example.com/api/link-preview?url=http://localhost:8000/"
```

**Mitigations Present:**
- ✅ Protocol whitelist (HTTP/HTTPS only)
- ✅ 5-second timeout
- ❌ NO internal IP/private network filtering
- ❌ NO cloud metadata endpoint blocking

**Recommendation:** Implement private IP blocklist (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7, fe80::/10)

### SSRF Sink #2: Tile Server Test Endpoint (CRITICAL)

**Severity:** HIGH
**Location:** `/repos/meshmonitor/src/server/routes/tileServerTest.ts` (Lines 412-426, 464-607)
**Endpoints:**
- `POST /api/tile-server/test` - Test single tile URL
- `POST /api/tile-server/autodetect` - Scan for working tile servers
**Authentication:** None required

**Vulnerability:**
```typescript
// Line 412-426: Test endpoint
router.post('/test', async (req, res) => {
  const { url, timeout = 5000 } = req.body;
  const result = await testTileUrl(url, timeout);
  res.json(result);
});

// Line 239-373: testTileUrl function
const response = await fetch(testUrl, {
  method: 'GET',
  signal: controller.signal
});
```

**Exploitability:** HIGH
- No authentication required (anyone can use it)
- Autodetect feature tests multiple URL patterns against a base URL
- Response data (HTTP status, size, content-type) leaked to attacker
- Can be used for systematic internal network scanning

**Proof of Concept:**
```bash
# Test endpoint
curl -X POST https://meshmonitor.example.com/api/tile-server/test \
  -H "Content-Type: application/json" \
  -d '{"url": "http://192.168.1.1/admin"}'

# Autodetect - scans multiple paths
curl -X POST https://meshmonitor.example.com/api/tile-server/autodetect \
  -H "Content-Type: application/json" \
  -d '{"baseUrl": "http://localhost"}'
```

**Mitigations Present:**
- ✅ 2-5 second timeouts
- ⚠️ DNS lookup check (bypassable with DNS rebinding)
- ❌ NO protocol validation
- ❌ NO internal IP filtering

**Recommendation:** Require authentication + implement IP blocklist

### SSRF Sink #3: Auto-Responder HTTP Trigger Test (MEDIUM)

**Severity:** MEDIUM
**Location:** `/repos/meshmonitor/src/server/server.ts` (Lines 8938-9000)
**Endpoint:** `POST /api/http/test`
**Authentication:** Requires `settings:read` permission

**Vulnerability:**
```typescript
apiRouter.post('/http/test', requirePermission('settings', 'read'), async (req, res) => {
  const { url } = req.body;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are allowed' });
  }

  // Line 8965: SSRF sink
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'text/plain, text/*, application/json',
      'User-Agent': 'MeshMonitor/AutoResponder-Test',
    },
    signal: controller.signal,
  });
});
```

**Exploitability:** MEDIUM (requires authentication)
- Can target internal services
- Response content (first 500 chars) returned to attacker
- 10-second timeout

**Mitigations Present:**
- ✅ Requires authentication
- ✅ Protocol validation (HTTP/HTTPS)
- ⚠️ Response truncated to 500 characters
- ❌ NO internal IP filtering

### SSRF Sink #4: Auto-Responder HTTP Triggers (Runtime) (CRITICAL)

**Severity:** CRITICAL
**Location:** `/repos/meshmonitor/src/server/meshtasticManager.ts` (Lines 8307-8357)
**Trigger:** Automatic (triggered by Meshtastic radio messages matching configured patterns)
**Authentication:** Admin required to configure triggers

**Vulnerability:**
```typescript
if (trigger.responseType === 'http') {
  let url = trigger.response;

  // Replace parameters extracted from message
  Object.entries(extractedParams).forEach(([key, value]) => {
    url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(value));
  });

  // Line 8330: SSRF sink
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'MeshMonitor/2.0' },
  });
}
```

**Configuration Endpoint:** `POST /api/settings` (lines 5050-5096 in server.ts) - No URL validation when triggers are saved

**Exploitability:** CRITICAL
- Admin can configure malicious HTTP URLs
- URLs triggered automatically by radio messages (no human approval)
- Attackers with physical access to Meshtastic network can trigger SSRF
- Can be used for persistent internal network scanning
- **No protocol restriction** (could use gopher://, file://, etc.)

**Attack Scenario:**
1. Compromised admin configures trigger with URL: `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
2. Attacker sends radio message matching trigger pattern
3. Server fetches AWS credentials from metadata endpoint
4. Credentials sent back via Meshtastic radio

**Mitigations Present:**
- ✅ Admin required to configure
- ✅ 5-second timeout
- ❌ NO URL validation when triggers are saved
- ❌ NO protocol restriction
- ❌ NO internal IP filtering

**Recommendation:** Add URL validation when triggers are created/updated. Block non-HTTP protocols, private IPs, and cloud metadata ranges.

### SSRF Sink #5: Script Content Proxy (LOW RISK)

**Severity:** LOW
**Location:** `/repos/meshmonitor/src/server/routes/scriptContentRoutes.ts` (Lines 128-242)
**Endpoint:** `GET /api/script-content?url=<github-url>`
**Authentication:** Optional

**Validation:**
```typescript
// Extensive allowlist validation
if (validatedUrl.hostname !== 'raw.githubusercontent.com') {
  return res.status(400).json({ error: 'Only raw.githubusercontent.com URLs are allowed' });
}

if (validatedUrl.protocol !== 'https:') {
  return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
}

// Path traversal prevention
const path = validatedUrl.pathname.substring(1);
if (!validateGitHubPath(path)) {
  return res.status(400).json({ error: 'Invalid GitHub path format' });
}
```

**Exploitability:** LOW
- Highly restricted to single domain (raw.githubusercontent.com)
- HTTPS only
- Path validation prevents traversal
- 10-second timeout
- 500KB file size limit

**Assessment:** Well-protected. Cannot target internal networks. **No remediation required.**

### SSRF Sink #6: Apprise Notification Service (LOW RISK)

**Severity:** LOW
**Location:** `/repos/meshmonitor/src/server/services/appriseNotificationService.ts` (Lines 92, 129, 178, 232)
**Description:** Sends notifications to Apprise API service
**Authentication:** Admin configures Apprise URL

**Requests:**
```typescript
// Health check
fetch(`${this.config.url}/health`, ...)

// Send notification
fetch(`${this.config!.url}/notify`, {
  method: 'POST',
  body: JSON.stringify({
    urls: urls,  // User-configured notification URLs
    ...
  })
})
```

**Exploitability:** LOW
- Requires admin compromise to change Apprise service URL
- User notification URLs passed to Apprise (Apprise validates them)
- Not directly exploitable from external attacker

### SSRF Sink #7: Scheduled Background Tasks (NO RISK)

**Severity:** NONE
**Locations:**
- `/repos/meshmonitor/src/server/services/newsService.ts` (line 105) - `https://meshmonitor.org/news.json`
- `/repos/meshmonitor/src/server/services/solarMonitoringService.ts` (line 97) - `https://api.forecast.solar/...`
- `/repos/meshmonitor/src/server/server.ts` (lines 543, 7553, 7561) - GitHub API

**Assessment:** Hardcoded domains or parameterized with numeric values only. No user control over URLs. **No exploitability.**

### SSRF Summary Table

| # | Endpoint | Severity | Auth Required | Internal IP Filter | Exploitability |
|---|----------|----------|---------------|-------------------|----------------|
| 1 | `/api/link-preview` | **HIGH** | Optional | ❌ None | **High** - Full SSRF |
| 2 | `/api/tile-server/test` | **HIGH** | ❌ No | ❌ None | **High** - Network scanner |
| 3 | `/api/http/test` | **MEDIUM** | ✅ Yes | ❌ None | Medium - Auth required |
| 4 | Auto-Responder HTTP (Runtime) | **CRITICAL** | Admin Config | ❌ None | **Critical** - Persistent |
| 5 | `/api/script-content` | **LOW** | Optional | ✅ Allowlist | Low - Single domain |
| 6 | Apprise Notifications | **LOW** | Admin Config | N/A | Low - Internal service |
| 7 | Background Tasks | **NONE** | N/A | N/A | None - Hardcoded |

### SSRF Recommendations (Priority Order)

**1. CRITICAL - Auto-Responder HTTP Triggers:**
- Add URL validation when triggers are saved
- Block non-HTTP/HTTPS protocols
- Implement private IP blocklist (RFC 1918, loopback, link-local, cloud metadata)

**2. HIGH - Link Preview Endpoint:**
- Implement IP blocklist for private networks
- Block cloud metadata endpoints (169.254.169.254, etc.)
- Consider requiring authentication

**3. HIGH - Tile Server Testing Endpoints:**
- Require authentication (at minimum)
- Implement IP blocklist
- Add rate limiting to prevent scanning abuse

**4. MEDIUM - HTTP Trigger Test Endpoint:**
- Add IP blocklist (already has auth requirement)

**5. Defense in Depth:**
- Implement DNS rebinding protection
- Use egress firewall rules to block private IP ranges
- Add SSRF protection library (e.g., ssrf-req-filter)
- Log all external requests for security monitoring

---

# Comprehensive Security Recommendations

## Critical Priority (Immediate Action Required)

### 1. WebSocket Permission Filtering (Data Leakage)
**Severity:** CRITICAL
**Location:** `/repos/meshmonitor/src/server/services/webSocketService.ts`
**Issue:** All authenticated users receive all data events, bypassing channel permissions
**Recommendation:** Implement per-user event filtering before broadcasting
```typescript
const handler = async (event: DataEvent) => {
  const userId = (socket as any).userId;

  if (event.type === 'message:new') {
    const message = event.data as DbMessage;
    const hasPermission = await checkChannelPermission(userId, message.channel, 'canRead');
    if (hasPermission) {
      socket.emit(event.type, transformedMessage);
    }
  }
};
```

### 2. SSRF Vulnerabilities (4 endpoints)
**Severity:** HIGH to CRITICAL
**Issue:** Multiple endpoints fetch user-provided URLs without internal IP filtering
**Recommendation:**
- Implement private IP blocklist library
- Block RFC 1918 addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Block loopback (127.0.0.0/8, ::1)
- Block link-local (169.254.0.0/16, fe80::/10)
- Block cloud metadata (169.254.169.254)

### 3. MFA Secrets Plaintext Storage
**Severity:** HIGH
**Location:** `/repos/meshmonitor/src/db/schema/auth.ts` (line 24)
**Issue:** TOTP secrets stored unencrypted in `mfa_secret` column
**Recommendation:** Implement application-level encryption with AES-256-GCM, keys derived from SESSION_SECRET + per-user salt

### 4. Database Backup Encryption
**Severity:** HIGH
**Location:** `/repos/meshmonitor/src/server/services/systemBackupService.ts`
**Issue:** Backups stored in plaintext YAML format
**Recommendation:** Implement GPG or AES-256 encryption for backups, store keys separately

## High Priority (30-60 days)

### 5. Database Encryption at Rest
**Issue:** Database files stored in plaintext on filesystem
**Recommendation:** Document encryption requirements, enable TDE for PostgreSQL/MySQL

### 6. SSL/TLS Enforcement for Database Connections
**Issue:** SSL/TLS optional for PostgreSQL/MySQL
**Recommendation:** Add `DATABASE_SSL_REQUIRED=true` option, enforce certificate validation

### 7. SESSION_SECRET Requirement
**Issue:** Auto-generated if not provided, invalidates sessions on restart
**Recommendation:** Require SESSION_SECRET in production or persist auto-generated secrets

### 8. HTTPS Enforcement
**Issue:** COOKIE_SECURE defaults to false
**Recommendation:** Add `FORCE_HTTPS=true` option, redirect HTTP to HTTPS in production

## Medium Priority (60-90 days)

### 9. ReDoS Protection
**Location:** `/repos/meshmonitor/src/server/server.ts` (lines 8658-8690)
**Issue:** User-controlled regex patterns in auto-responders lack complexity validation
**Recommendation:** Implement regex complexity checking or use safe-regex library

### 10. Data Retention Policies
**Issue:** No automatic data expiration (audit logs, messages, inactive users)
**Recommendation:** Implement configurable retention periods with automated purging

### 11. Channel PSK Encryption
**Issue:** Channel encryption keys stored base64-encoded (plaintext)
**Note:** Operational requirement for server-side decryption
**Recommendation:** Document limitation, enhance access logging, consider encryption with key derivation

### 12. GDPR Data Export/Deletion
**Issue:** No user-specific data export endpoint, no "right to erasure" implementation
**Recommendation:** Add GDPR-compliant export API, implement anonymization for audit logs

## Low Priority (Ongoing)

### 13. Rate Limit Bypass Prevention
**Issue:** Setting rate limits to 0 disables protection
**Recommendation:** Require explicit "unlimited" keyword, log warnings

### 14. Log Rotation and Retention
**Issue:** Audit logs grow indefinitely
**Recommendation:** Implement automated log rotation, configurable retention

### 15. API Token Prefix Length
**Issue:** 12-character prefix may aid brute force (minimal risk with bcrypt)
**Recommendation:** Consider shortening to 8 characters

### 16. MFA Backup Code Count
**Issue:** 10 backup codes may be excessive
**Recommendation:** Reduce to 5-8 codes

### 17. Security Headers Documentation
**Issue:** HSTS and Cache-Control require reverse proxy configuration
**Recommendation:** Document Nginx/Caddy security header configuration examples

---

# Summary & Conclusion

MeshMonitor demonstrates **strong security fundamentals** with comprehensive authentication mechanisms (local, OIDC, MFA, API tokens), bcrypt password hashing, SQL injection protection via ORM, extensive rate limiting, CSRF protection, and detailed audit logging. The codebase follows mature engineering practices with TypeScript strict mode, clear separation of concerns, and defense-in-depth principles.

**Critical vulnerabilities requiring immediate remediation:**
1. **WebSocket Permission Filtering** - All authenticated users receive all data events, bypassing channel permissions (data isolation failure)
2. **SSRF Vulnerabilities** - Four endpoints lack internal IP filtering (link preview, tile server testing, HTTP auto-responder triggers)
3. **MFA Secret Storage** - TOTP secrets stored in plaintext in database
4. **Backup Encryption** - System backups stored unencrypted

**Overall Security Rating:** STRONG (with critical fixes needed)

With the recommended critical fixes implemented, MeshMonitor would achieve an **EXCELLENT** security rating suitable for production deployment in privacy-sensitive mesh network monitoring environments. The application's comprehensive security architecture, combined with proper deployment hardening (HTTPS enforcement, database encryption, backup protection), provides robust protection against common attack vectors while maintaining usability and operational flexibility.

**Attack Surface Summary:**
- 250+ REST API endpoints with authentication/authorization enforcement
- WebSocket real-time updates (permission filtering needed)
- Script execution engine with path validation (admin-only)
- File upload functionality with extension whitelisting
- Multi-database support with parameterized queries
- OIDC/OAuth integration with PKCE security

**Defensive Strengths:**
- Multi-tier rate limiting (API, auth, messages, device operations)
- Comprehensive audit logging with IP tracking
- Granular resource-based permissions
- Session security (HttpOnly, Secure, SameSite flags)
- bcrypt password hashing (12 rounds)
- CSRF double-submit token pattern
- Dynamic Content Security Policy
- Docker security (non-root user, capability dropping)

The thoroughness of this analysis, combined with specific file locations, line numbers, and proof-of-concept examples, provides a complete foundation for the security assessment workflow. Subsequent agents in the penetration testing pipeline now have detailed intelligence on authentication endpoints, SSRF attack vectors, permission boundaries, and data isolation mechanisms necessary for effective vulnerability exploitation and validation.

---

**END OF COMPREHENSIVE SECURITY ANALYSIS**
