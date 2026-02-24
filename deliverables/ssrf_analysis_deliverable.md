# SSRF Analysis Report

## 1. Executive Summary

- **Analysis Status:** Complete
- **Key Outcome:** Two high-confidence server-side request forgery vulnerabilities were identified, both allowing attackers to access internal services and cloud metadata endpoints. One endpoint implements strong defenses and is considered secure.
- **Purpose of this Document:** This report provides strategic context on the application's outbound request mechanisms, dominant flaw patterns, and key architectural details necessary to effectively exploit the vulnerabilities listed in the exploitation queue.

### Summary of Findings

| Endpoint | Verdict | Confidence | Externally Exploitable | Impact |
|----------|---------|------------|----------------------|--------|
| `GET /api/link-preview` | **VULNERABLE** | High | Yes (Anonymous) | Cloud metadata access, internal service access, network scanning |
| `GET /api/script-content` | **SAFE** | High | N/A | Strong hostname allowlist prevents exploitation |
| `POST /api/http/test` | **VULNERABLE** | High | Yes (Requires auth + settings:read) | Cloud metadata access, internal service access, network scanning |

### Critical Findings

**SSRF-VULN-01: Link Preview Metadata Exfiltration**
- **Endpoint:** `GET /api/link-preview?url=<url>`
- **Authentication:** None required (anonymous access)
- **Impact:** Attackers can access AWS/Azure/GCP metadata endpoints to steal IAM credentials, enumerate internal services, and perform network reconnaissance
- **Root Cause:** No internal IP address blocking or cloud metadata endpoint restrictions

**SSRF-VULN-02: HTTP Trigger Test Internal Network Access**
- **Endpoint:** `POST /api/http/test` with `{url}` body
- **Authentication:** Requires `settings:read` permission
- **Impact:** Similar to SSRF-VULN-01, allows internal service access and cloud metadata retrieval
- **Root Cause:** No internal IP address blocking or cloud metadata endpoint restrictions

## 2. Dominant Vulnerability Patterns

### Pattern 1: Insufficient URL Validation for Internal IP Ranges
- **Description:** A recurring and critical pattern was observed where user-supplied URLs are validated for protocol scheme (HTTP/HTTPS) but not for destination IP address. Both vulnerable endpoints allow requests to internal IP ranges (RFC 1918 private networks, loopback addresses, and link-local addresses) without restriction.
- **Implication:** Attackers can force the server to make requests to internal services that should not be accessible from the internet, including databases, caching layers, admin interfaces, and cloud metadata endpoints.
- **Representative Findings:** `SSRF-VULN-01`, `SSRF-VULN-02`
- **Technical Root Cause:** The URL validation logic checks `validatedUrl.protocol` against an allowlist but never validates `validatedUrl.hostname` or performs DNS resolution to check if the target IP is in a restricted range.

### Pattern 2: Cloud Metadata Endpoint Exposure
- **Description:** Both vulnerable endpoints allow HTTP requests to `169.254.169.254`, the cloud metadata service endpoint used by AWS, Azure, and GCP. This IP address should be explicitly blocked in any SSRF defense.
- **Implication:** When deployed in cloud environments (AWS EC2, Azure VMs, GCP Compute), attackers can retrieve instance metadata including IAM role credentials, SSH keys, user data scripts, and internal network configuration.
- **Representative Findings:** `SSRF-VULN-01`, `SSRF-VULN-02`
- **Example Attack:** `http://169.254.169.254/latest/meta-data/iam/security-credentials/` returns temporary AWS credentials with full permissions of the instance's IAM role.

### Pattern 3: Non-Blind SSRF with Full Response Disclosure
- **Description:** Both vulnerable endpoints return the full HTTP response body (truncated to 500 characters), status code, and timing information to the attacker. This "non-blind" behavior significantly increases exploitability.
- **Implication:** Attackers can read responses from internal services, making it easy to enumerate services, extract data, and confirm successful exploitation. Timing differences also enable port scanning.
- **Representative Findings:** `SSRF-VULN-01`, `SSRF-VULN-02`
- **Contrast with Blind SSRF:** Blind SSRF (where no response is returned) is harder to exploit and typically limited to denial-of-service or triggering actions. Non-blind SSRF enables full data exfiltration.

### Pattern 4: Strong Defense Example - Hostname Allowlisting
- **Description:** The `/api/script-content` endpoint demonstrates the correct approach to SSRF prevention by implementing strict hostname allowlisting (`raw.githubusercontent.com` only).
- **Implication:** When properly implemented, hostname allowlisting is the most effective SSRF defense, completely preventing access to unintended targets.
- **Representative Finding:** `GET /api/script-content` (SAFE)
- **Key Implementation:** `if (validatedUrl.hostname !== 'raw.githubusercontent.com') { return res.status(400).json({ error: 'Only raw.githubusercontent.com URLs are allowed' }); }`

## 3. Strategic Intelligence for Exploitation

### HTTP Client Library
- **Library:** Node.js native `fetch()` API (built-in since Node.js 18)
- **Characteristics:** Modern Promise-based API, supports AbortController for timeouts, follows redirects by default
- **Security Implications:**
  - Follows HTTP redirects automatically (potential bypass if initial URL passes validation but redirects to internal IP)
  - Supports both HTTP/1.1 and HTTP/2
  - Default timeout is infinite (mitigated by AbortController usage in vulnerable endpoints)

### Request Architecture
- **Common Pattern:** All three endpoints follow this structure:
  1. Extract URL from query parameter or POST body
  2. Validate URL format with `new URL()` constructor
  3. Check protocol against allowlist (http/https)
  4. Optional: Additional validations (hostname allowlist in script-content)
  5. Call `fetch(url)` with timeout via AbortController
  6. Return response to user (status, headers, body excerpt)

- **Timeout Configuration:**
  - `/api/link-preview`: 5 seconds (line 93)
  - `/api/script-content`: 10 seconds (line 167)
  - `/api/http/test`: 10 seconds (line 8962)

- **Response Size Limits:**
  - `/api/link-preview`: No enforced limit (comment suggests intent)
  - `/api/script-content`: 500KB maximum (lines 200-204)
  - `/api/http/test`: Response truncated to 500 characters (line 8985)

### Internal Services Discovery
Based on reconnaissance and code analysis, the following internal services are likely present and accessible via SSRF:

| Service Type | Default Port | Purpose | Attack Value |
|-------------|--------------|---------|--------------|
| **Database** | 3306 (MySQL) / 5432 (PostgreSQL) / N/A (SQLite) | Primary data store | HIGH - Direct data access if no authentication |
| **Session Store** | Same as database | Session persistence | HIGH - Session hijacking |
| **Redis/Cache** | 6379 | Potential caching layer | MEDIUM - Session tokens, cached data |
| **Meshtastic Device Connection** | Varies (serial/TCP) | Device communication | LOW - Application-specific protocol |
| **Application Server** | Loopback interfaces | Self-referential requests | MEDIUM - Potential authentication bypass |
| **Cloud Metadata** | 169.254.169.254 | AWS/Azure/GCP instance metadata | **CRITICAL** - IAM credentials |

### Cloud Metadata Endpoints by Provider

**AWS EC2:**
```
http://169.254.169.254/latest/meta-data/
http://169.254.169.254/latest/meta-data/iam/security-credentials/
http://169.254.169.254/latest/meta-data/iam/security-credentials/<role-name>
http://169.254.169.254/latest/user-data/
```

**Azure:**
```
http://169.254.169.254/metadata/instance?api-version=2021-02-01
http://169.254.169.254/metadata/identity/oauth2/token
```

**Google Cloud:**
```
http://metadata.google.internal/computeMetadata/v1/
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
```

### Authentication Requirements

| Endpoint | Authentication | Permission | Difficulty |
|----------|---------------|------------|------------|
| `/api/link-preview` | **None** (optionalAuth) | None | **Trivial** - Unauthenticated exploitation |
| `/api/script-content` | None (optionalAuth) | None | N/A (SAFE) |
| `/api/http/test` | Required | `settings:read` | **Low** - Common permission for regular users |

**Key Finding:** The most severe vulnerability (`/api/link-preview`) requires **no authentication**, making it exploitable by any internet user. The second vulnerability requires only the `settings:read` permission, which is commonly granted to regular users who need to view application settings.

### Network Topology Considerations
- **Deployment Model:** Self-hosted application, typically deployed behind reverse proxy (Nginx/Apache)
- **Reverse Proxy Headers:** Application trusts `X-Forwarded-For` and `X-Real-IP` headers for IP detection
- **Network Segmentation:** Server likely has access to internal network segments not accessible from internet
- **Firewall Rules:** External firewall rules irrelevant for SSRF (server-side requests originate from trusted IP)

