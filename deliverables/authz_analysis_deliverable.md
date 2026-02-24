# Authorization Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Multiple high-confidence authorization vulnerabilities (horizontal IDOR, admin-level IDOR, context workflow bypass, and self-protection race conditions) were identified. All externally exploitable findings have been passed to the exploitation phase via the machine-readable exploitation queue.
- **Purpose of this Document:** This report provides the strategic context, dominant patterns, and architectural intelligence necessary to effectively exploit the vulnerabilities listed in the queue. It is intended to be read alongside the JSON deliverable.

**Critical Findings Summary:**
- **5 Horizontal IDOR vulnerabilities** allowing unauthorized access to other users' data
- **3 Admin-level IDOR vulnerabilities** in channel database management
- **1 Context workflow vulnerability** in script execution
- **2 Self-protection bypasses** (race condition + missing checks)

**Secure Components:**
- All vertical privilege escalation vectors properly protected with `requireAdmin()`
- MFA and OIDC workflows have proper state validation
- Channel-specific message access correctly enforced
- Permission escalation properly prevented

## 2. Dominant Vulnerability Patterns

### Pattern 1: Missing Node Ownership Validation (Horizontal IDOR)
- **Description:** Multiple endpoints accept node identifiers and resource IDs without verifying the requesting user has ownership or proper relationship to those specific resources. The permission system checks for generic capabilities (e.g., `messages:read`) but not resource-specific authorization (e.g., "can this user access messages between THESE nodes?")
- **Implication:** Users with basic read permissions can enumerate and access data for any node in the mesh network, regardless of whether they own or should have access to those nodes
- **Representative Findings:** AUTHZ-VULN-01 (Direct Messages), AUTHZ-VULN-02 (Telemetry Data)

### Pattern 2: Admin-Level IDOR in Channel Database (Horizontal within Admin Role)
- **Description:** Channel database endpoints require admin privileges but lack ownership validation, allowing any admin to access, modify, or delete encryption keys created by other admins. The `createdBy` field exists in the database schema but is never used for authorization checks.
- **Implication:** In multi-admin deployments, admins cannot protect their channel configurations from other admins, violating separation of duties and enabling insider threats
- **Representative Findings:** AUTHZ-VULN-03, AUTHZ-VULN-04, AUTHZ-VULN-05 (Channel Database CRUD operations)

### Pattern 3: Global Node Properties Masquerading as User Preferences
- **Description:** Node favorites, ignored lists, and position overrides are stored as global node properties but exposed through an API that implies user-specific preferences. Any user with `nodes:write` permission can modify these properties, affecting all users' views.
- **Implication:** Users can manipulate the mesh network view for all users, causing confusion about node favorites, hiding/unhiding nodes globally, and spoofing node locations for everyone
- **Architectural Issue:** This pattern represents a design mismatch rather than a traditional security vulnerability, but the API semantics are misleading and could enable denial-of-service or social engineering attacks
- **Note:** These are documented for completeness but marked as low priority given MeshMonitor's architecture as a self-hosted monitoring tool

### Pattern 4: Missing User Scoping in Script Execution
- **Description:** Scripts uploaded by users are stored in a shared directory without user ownership tracking. Any user with appropriate permissions can test, configure triggers for, or execute scripts uploaded by other users.
- **Implication:** Lack of script ownership enables cross-user script execution, removing accountability and potentially allowing users to leverage other users' scripts in unintended ways
- **Representative Finding:** AUTHZ-VULN-06 (Script Execution Context Workflow)

### Pattern 5: Self-Protection Race Conditions
- **Description:** Self-protection mechanisms (cannot delete last admin, cannot delete anonymous user) check state before operations but lack transactional guarantees. Concurrent requests can bypass these protections through race conditions.
- **Implication:** Multiple simultaneous admin deletion requests could result in zero active admins, causing a complete lockout of administrative functions
- **Representative Findings:** AUTHZ-VULN-07, AUTHZ-VULN-08 (Last Admin + Anonymous User Protection)

## 3. Strategic Intelligence for Exploitation

### Session Management Architecture
- **Session Storage:** Server-side sessions in database (SQLite/PostgreSQL/MySQL)
- **Session Cookie:** `meshmonitor.sid` (configurable name) with `httpOnly` flag
- **Session Content:** userId, username, authProvider, isAdmin, csrfToken
- **Critical Finding:** User ID from session is trusted for authentication but not consistently validated for resource ownership. The application assumes `messages:read` permission means "can read all messages" rather than "can read messages I have access to."

### Role/Permission Model
- **Roles:** `anonymous` (minimal read), `user` (permission-based), `admin` (full access)
- **Permission Storage:** Database `permissions` table with resource + action granularity
- **Admin Bypass:** Admins bypass ALL permission checks (`if (user.isAdmin) return true`)
- **Critical Finding:** The permission model is coarse-grained (resource-level) without object-level authorization. Having `messages:read` grants access to ALL messages, not just messages the user should see.

### Resource Access Patterns
- **Node Data:** Endpoints accept `nodeId` parameters and fetch data for any node (no ownership checks)
- **Direct Messages:** Endpoints accept two `nodeId` parameters and fetch DMs between any two nodes
- **Channel Database:** Endpoints accept channel DB `id` and fetch/modify any channel (only admin check, no ownership)
- **Critical Finding:** Object identifiers are directly passed to database queries without validating the user's relationship to those objects

### Workflow Implementation
- **MFA Workflows:** Properly use session-bound state (`pendingMfaUserId`, `mfaSecret`)
- **OIDC Workflow:** Properly validates state parameter with PKCE and nonce
- **Script Workflow:** Scripts stored globally without user association
- **Critical Finding:** MFA and OIDC workflows are secure, but script execution lacks user scoping

## 4. Vectors Analyzed and Confirmed Secure

These authorization checks were traced and confirmed to have robust, properly-placed guards. They are **low-priority** for further testing.

| **Endpoint** | **Guard Location** | **Defense Mechanism** | **Verdict** |
|--------------|-------------------|----------------------|-------------|
| `DELETE /api/messages/:id` | messageRoutes.ts:120-139 | Channel-specific write permission checked before deletion | SAFE |
| `GET /api/messages/channel/:channel` | server.ts:1785-1793 | Dynamic channel permission (`channel_X:read`) validated before query | SAFE |
| `GET /api/users` | userRoutes.ts:17 | Global `requireAdmin()` on entire router | SAFE |
| `POST /api/users` | userRoutes.ts:17 | Global `requireAdmin()` on entire router | SAFE |
| `PUT /api/users/:id` | userRoutes.ts:17 | Global `requireAdmin()` on entire router | SAFE |
| `DELETE /api/users/:id` | userRoutes.ts:17 | Global `requireAdmin()` on entire router (+ self-protection at line 181) | SAFE |
| `PUT /api/users/:id/admin` | userRoutes.ts:17 + 312 | Global admin middleware + cannot demote self | SAFE |
| `PUT /api/users/:id/permissions` | userRoutes.ts:17 | Global `requireAdmin()` on entire router | SAFE |
| `DELETE /api/users/:id/mfa` | userRoutes.ts:17 | Global `requireAdmin()` on entire router | SAFE |
| `POST /api/admin/commands` | server.ts:7183 | `requireAdmin()` middleware | SAFE |
| `POST /api/admin/import-config` | server.ts:7035 | `requireAdmin()` middleware | SAFE |
| `POST /api/admin/export-config` | server.ts:6906 | `requireAdmin()` middleware | SAFE |
| `POST /api/mfa/setup` | mfaRoutes.ts:36 | `requireAuth()` + user ID from session | SAFE |
| `POST /api/mfa/verify-setup` | mfaRoutes.ts:100-107 | Validates `mfaSecret` exists and belongs to session user | SAFE |
| `POST /api/auth/verify-mfa` | authRoutes.ts:322-336 | Session-bound `pendingMfaUserId` validated | SAFE |
| `GET /api/auth/oidc/callback` | authRoutes.ts:494-500 + oidcAuth.ts:118-123 | State parameter validation with PKCE and nonce | SAFE |

### Permission Escalation Prevention
- **No self-service permission modification:** All permission changes require admin access
- **Database-backed authorization:** Permissions queried fresh from database on every request
- **No JWT tampering:** Application uses server-side sessions, not client-side JWTs
- **No profile/me escalation endpoints:** No endpoints allow users to modify their own permissions

## 5. Analysis Constraints and Blind Spots

### Analyzed Components
- ✅ All horizontal authorization candidates from reconnaissance report Section 8.1
- ✅ All vertical privilege escalation vectors from reconnaissance report Section 8.2
- ✅ All context-based workflow candidates from reconnaissance report Section 8.3
- ✅ All self-protection mechanisms from reconnaissance report Section 8.4
- ✅ Permission system architecture and escalation vectors
- ✅ 200+ API endpoints with authorization controls

### Limitations and Blind Spots

**1. Device-to-Server Authorization**
- The Meshtastic device connection authorization (protobuf-based communication) was not analyzed
- Admin channel commands sent to the physical device were not traced beyond the HTTP endpoint
- Assumption: Device-level authorization is out of scope for web application testing

**2. WebSocket Authorization**
- WebSocket connections use session-based authentication (verified in code)
- Real-time message broadcasting authorization logic was not deeply analyzed
- Assumption: If a user has permission to read messages via REST API, they can receive them via WebSocket

**3. Runtime Permission Resolution**
- The application queries permissions from the database on every request
- Dynamic permission changes (admin modifying user permissions) take effect immediately
- No caching layer was observed, but runtime edge cases were not live-tested

**4. Multi-Instance Deployments**
- Analysis assumes single-instance deployment (typical for self-hosted tool)
- Race condition vulnerabilities (AUTHZ-VULN-07, AUTHZ-VULN-08) would be more severe in multi-instance deployments with shared database
- Load balancer session affinity was not analyzed

**5. Database-Level Constraints**
- Foreign key constraints, triggers, and database-level authorization were not analyzed
- Assumption: Application-level authorization is the primary defense

**6. External OIDC Provider Authorization**
- OIDC integration was analyzed for state validation and session security
- The external identity provider's authorization claims were not validated in depth
- Assumption: The application trusts the OIDC provider's user claims

### Architectural Context: Self-Hosted Monitoring Tool
MeshMonitor is designed as a **self-hosted application** for monitoring Meshtastic mesh networks, not a multi-tenant SaaS platform. This context is critical for interpreting some findings:

- **Node favorites/ignored/overrides** being global properties may be intentional for single-team deployments
- **Admin IDOR in channel database** is more severe in multi-admin scenarios (different teams/departments)
- **Script sharing** without ownership may be acceptable for trusted team environments

However, these patterns still represent **authorization vulnerabilities** because:
1. The API semantics imply user-specific resources (misleading design)
2. Multi-admin deployments (even in single organizations) exist and need separation of duties
3. The permission system suggests fine-grained access control, but object-level authorization is missing

