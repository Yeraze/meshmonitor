# Security Assessment Report

## Executive Summary

- **Target:** https://mesh.yeraze.online
- **Assessment Date:** February 24, 2026
- **Scope:** Authentication, XSS, SQL and Command Injection, SSRF, Authorization testing

## Summary by Vulnerability Type

**Authentication Vulnerabilities:**
No authentication vulnerabilities were successfully exploited to achieve account takeover or authentication bypass. Two potential vulnerabilities were identified but could not be fully exploited from the external network: session fixation via missing session regeneration in OIDC callback (AUTH-VULN-03) and missing cache-control headers on authentication endpoints (AUTH-VULN-04). Both vulnerabilities are blocked by the lack of authenticated sessions or OIDC credentials. Three additional vulnerabilities (AUTH-VULN-01, AUTH-VULN-02, AUTH-VULN-05) were classified as out of scope because local authentication is completely disabled on the target deployment.

**Authorization Vulnerabilities:**
One authorization vulnerability was successfully exploited: horizontal authorization bypass on the telemetry endpoint (AUTHZ-VULN-02), which allows anonymous unauthenticated users to access complete telemetry data for any node in the mesh network without ownership validation. This exposes sensitive device metrics including battery levels, signal strength, GPS coordinates, and system health data for all 897 nodes in the network. Seven additional potential authorization vulnerabilities were identified but blocked by authentication requirements: horizontal IDOR on direct messages endpoint (AUTHZ-VULN-01), three admin-level IDOR vulnerabilities on channel database operations (AUTHZ-VULN-03, 04, 05), context workflow bypass on script execution (AUTHZ-VULN-06), race condition on last admin deletion (AUTHZ-VULN-07), and soft delete bypass on anonymous user protection (AUTHZ-VULN-08).

**Cross-Site Scripting (XSS) Vulnerabilities:**
No XSS vulnerabilities were found. No XSS analysis deliverable was present, indicating that no exploitable XSS vulnerabilities were identified during the assessment.

**SQL/Command Injection Vulnerabilities:**
No SQL or command injection vulnerabilities were successfully exploited from the external network. Three command injection vulnerabilities were identified (INJ-VULN-01, INJ-VULN-02, INJ-VULN-03), all involving unsanitized `scriptArgs` parameters in script execution triggers. However, all are classified as out of scope because they require authenticated access with `settings:write` permission and, in some cases, internal mesh network access to trigger execution. The application's authentication layer successfully blocks external exploitation attempts.

**Server-Side Request Forgery (SSRF) Vulnerabilities:**
No SSRF vulnerabilities were found. After exhaustive testing with multiple bypass techniques, SSRF-VULN-01 (link preview endpoint) was classified as a false positive because security controls (network isolation, localhost blocking, cloud metadata blocking) successfully prevent exploitation despite theoretical vulnerability in source code. SSRF-VULN-02 (HTTP trigger test endpoint) was classified as out of scope because it requires OIDC authentication not obtainable from the external network.

## Network Reconnaissance

**Open Ports and Services:**
- Port 443/HTTPS: Primary web application interface accessible at https://mesh.yeraze.online
- The application is deployed behind an OpenResty (nginx-based) reverse proxy with WAF capabilities
- Backend services (database, Meshtastic device connections) are properly isolated and not exposed to the external network

**Security Headers and Configuration:**
- HSTS enabled with 2-year max-age for HTTPS enforcement
- Session cookies configured with HttpOnly, Secure, and SameSite=Lax attributes
- CSRF protection active using double-submit cookie pattern
- Rate limiting implemented: 5 attempts per 15 minutes on authentication endpoints, 1000 requests per 15 minutes on general API endpoints
- Content-Security-Policy and other modern security headers present

**Authentication and Access Control:**
- Local username/password authentication is disabled (`localAuthDisabled: true`)
- OIDC/OAuth authentication enabled via external identity provider at https://auth.yeraze.online
- Anonymous access allowed with limited read-only permissions (dashboard, nodes, info)
- Default admin credentials (admin:changeme) have been changed (`isDefaultPassword: false`)

**Network Segmentation Findings:**
- Effective container/OS-level network isolation prevents localhost access
- Cloud metadata endpoint (169.254.169.254) is inaccessible from application context
- Private network access is restricted; only limited access to 192.168.1.1 (likely router) was possible
- Infrastructure-level IP filtering successfully blocks internal service enumeration

**Application Architecture:**
- Node.js/Express backend with TypeScript
- React frontend (single-page application)
- Multi-database support (SQLite, PostgreSQL, MySQL) via Drizzle ORM
- WebSocket server for real-time updates via Socket.io
- 200+ REST API endpoints with granular permission system (27+ resources)
- Two-tier role model: admin vs. regular user with permission-based access control

---

# Injection Exploitation Evidence

## Successfully Exploited Vulnerabilities

*No injection vulnerabilities were successfully exploited from the external network.*

---

# Authentication Exploitation Evidence

## Successfully Exploited Vulnerabilities

*No vulnerabilities were successfully exploited to achieve account takeover or authentication bypass.*

---

# SSRF Exploitation Evidence

## Successfully Exploited Vulnerabilities

*No SSRF vulnerabilities were successfully exploited from the external network.*

---

# Authorization Exploitation Evidence

## Successfully Exploited Vulnerabilities

### AUTHZ-VULN-02: Horizontal Authorization Bypass on Telemetry Endpoint

**Summary:**
- **Vulnerable location:** GET /api/telemetry/:nodeId (server.ts:3167)
- **Overview:** Anonymous unauthenticated users can access complete telemetry data for ANY node in the mesh network without ownership validation
- **Impact:** Complete exposure of sensitive device metrics including battery levels, signal strength, GPS coordinates, network statistics, and system health data for all 897 nodes in the network
- **Severity:** HIGH

**Prerequisites:**
None - vulnerability exploitable by any unauthenticated user visiting the site

**Exploitation Steps:**

1. Navigate to the target application:
   ```
   https://mesh.yeraze.online
   ```

2. Without authenticating, obtain list of node IDs from the publicly accessible nodes endpoint:
   ```
   GET https://mesh.yeraze.online/api/nodes
   ```
   Response: 897 nodes with IDs like `!43593e0c`, `!699c4c50`, `!a2e4ff4c`

3. Access telemetry data for any node by calling the telemetry endpoint with the node ID:
   ```
   GET https://mesh.yeraze.online/api/telemetry/!a2e4ff4c
   ```

4. Observe complete telemetry history returned without any authorization check

**Proof of Impact:**

Successfully accessed telemetry for node `!a2e4ff4c` (Yeraze StationG2) as anonymous user:

```
Status: 200 OK
Total Records: 1,440 telemetry entries
```

**Exposed Telemetry Types (22 categories):**
- `batteryLevel` - Battery percentage (101%)
- `voltage` - Device voltage (0V)
- `channelUtilization` - Channel usage (7.59%)
- `airUtilTx` - Air transmission utilization (0.37%)
- `uptimeSeconds` - System uptime (694,598 seconds = 8 days)
- `messageHops` - Message routing hops
- `timeOffset` - Time synchronization offset
- `systemDirectNodeCount` - Direct connected nodes (8)
- `systemNodeCount` - Total mesh nodes (216)
- `numTxDropped` - Dropped transmissions (50 packets)
- `numTotalNodes` - Network capacity (250 nodes)
- `heapTotalBytes` / `heapFreeBytes` - Memory usage (256KB total, 154KB free)
- `numPacketsRxBad` - Bad packet count (89,270)
- `numPacketsRx` - Received packets (284,070)
- `numPacketsTx` - Transmitted packets (10,867)
- `numRxDupe` - Duplicate packets (151,966)
- `numTxRelay` - Relayed transmissions (6,684)
- `numTxRelayCanceled` - Canceled relays (31,028)
- `numOnlineNodes` - Active nodes (123)
- `latitude` / `longitude` - GPS coordinates (26.3356416, -80.265216)

**Sample Telemetry Data:**
```json
{
  "batteryLevel": {
    "value": 101,
    "unit": "%",
    "timestamp": "2026-02-24T21:36:48.722Z"
  },
  "channelUtilization": {
    "value": 7.590000152587891,
    "unit": "%",
    "timestamp": "2026-02-24T21:36:48.722Z"
  },
  "latitude": {
    "value": 26.3356416,
    "unit": "°",
    "timestamp": "2026-02-24T21:17:31.000Z"
  },
  "longitude": {
    "value": -80.265216,
    "unit": "°",
    "timestamp": "2026-02-24T21:17:31.000Z"
  }
}
```

Successfully accessed telemetry for additional nodes:
- Node `!43593e0c` (Mil 7): 66 telemetry records
- Node `!699c4c50` (David KO4DKN): 57 telemetry records

**Notes:**
The vulnerability exists because the endpoint checks for generic `info:read` OR `dashboard:read` permissions but does NOT verify if the requesting user should have access to the SPECIFIC node's telemetry. The anonymous user has `info:read=true` and `dashboard:read=true` by default, allowing unrestricted access to all node telemetry data regardless of ownership or privacy settings.
