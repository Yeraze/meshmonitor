# Backend Security Code Review - MeshMonitor v2.3.1

## Executive Summary

This comprehensive security review of the MeshMonitor backend identifies several security vulnerabilities and areas for improvement. The application demonstrates good security practices in many areas, particularly in database query parameterization and authentication flow. However, critical vulnerabilities exist that require immediate attention.

## Critical Findings (Immediate Action Required)

### 1. **[CRITICAL] Missing Security Headers**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Lines:** 119-124
**Severity:** Critical
**Impact:** Application vulnerable to XSS, clickjacking, MIME sniffing attacks

**Current Code:**
```typescript
// Middleware
app.use(cors({
  origin: true,  // Allow same-origin requests
  credentials: true  // Allow cookies
}));
app.use(express.json());
```

**Vulnerability:** No security headers (Helmet.js) configured. Missing:
- Content-Security-Policy (CSP)
- X-Frame-Options
- X-Content-Type-Options
- Strict-Transport-Security (HSTS)
- X-XSS-Protection

**Remediation:**
```typescript
import helmet from 'helmet';

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Tighten in production
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));
```

### 2. **[CRITICAL] Overly Permissive CORS Configuration**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Lines:** 120-123
**Severity:** Critical
**Impact:** Allows any origin to make authenticated requests

**Current Code:**
```typescript
app.use(cors({
  origin: true,  // Allow same-origin requests
  credentials: true  // Allow cookies
}));
```

**Vulnerability:** `origin: true` with `credentials: true` allows any origin to send authenticated requests.

**Remediation:**
```typescript
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];

    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
```

## High Severity Findings

### 3. **[HIGH] Missing Rate Limiting**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Severity:** High
**Impact:** API vulnerable to brute force attacks, DoS

**Vulnerability:** No rate limiting implemented on any endpoints, particularly critical for:
- `/api/auth/login` - Password brute force
- `/api/messages/send` - Message flooding
- `/api/traceroute` - Resource exhaustion

**Remediation:**
```typescript
import rateLimit from 'express-rate-limit';

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP'
});

// Strict limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true
});

// Apply limiters
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
```

### 4. **[HIGH] Weak Session Secret Configuration**
**File:** `/home/yeraze/Development/meshmonitor/src/server/auth/sessionConfig.ts`
**Lines:** 36-39, 111
**Severity:** High
**Impact:** Sessions can be hijacked if default secret is used

**Current Code:**
```typescript
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.warn('⚠️  SESSION_SECRET not set! Using insecure default. Set SESSION_SECRET in production!');
}
// ...
secret: sessionSecret || 'insecure-dev-secret-change-in-production',
```

**Vulnerability:** Falls back to hardcoded secret, warning only logged.

**Remediation:**
```typescript
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production environment');
  }
  logger.warn('⚠️  SESSION_SECRET not set! Using random secret for development');
  return crypto.randomBytes(32).toString('hex');
}
```

### 5. **[HIGH] Missing CSRF Protection**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Severity:** High
**Impact:** State-changing operations vulnerable to CSRF attacks

**Vulnerability:** No CSRF tokens implemented for state-changing operations despite cookie-based authentication.

**Remediation:**
```typescript
import csrf from 'csurf';

// CSRF protection
const csrfProtection = csrf({ cookie: false }); // Use session for CSRF tokens

// Apply to state-changing routes
apiRouter.post('/messages/send', csrfProtection, requirePermission('messages', 'write'), async (req, res) => {
  // ... existing code
});

// Add CSRF token endpoint
apiRouter.get('/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});
```

## Medium Severity Findings

### 6. **[MEDIUM] Insufficient Input Validation**
**Files:** Multiple route handlers
**Severity:** Medium
**Impact:** Potential for injection attacks, data corruption

**Examples of missing validation:**

1. **Node ID validation** (`/home/yeraze/Development/meshmonitor/src/server/server.ts:356-367`):
```typescript
// Current - only validates format
if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
  // error
}

// Should also validate range
const nodeNum = parseInt(nodeNumStr, 16);
if (nodeNum < 0 || nodeNum > 0xFFFFFFFF) {
  return res.status(400).json({ error: 'Invalid node number range' });
}
```

2. **Message text validation** (`/home/yeraze/Development/meshmonitor/src/server/server.ts:685-688`):
```typescript
// Current
if (!text || typeof text !== 'string') {
  return res.status(400).json({ error: 'Message text is required' });
}

// Should add
if (text.length > 237) { // Meshtastic limit
  return res.status(400).json({ error: 'Message too long (max 237 characters)' });
}
if (!/^[\x20-\x7E\n\r]*$/.test(text)) {
  return res.status(400).json({ error: 'Message contains invalid characters' });
}
```

### 7. **[MEDIUM] Weak Password Requirements**
**File:** `/home/yeraze/Development/meshmonitor/src/server/auth/localAuth.ts`
**Lines:** 55-57, 130-132
**Severity:** Medium
**Impact:** Weak passwords allowed

**Current Code:**
```typescript
if (password.length < 8) {
  throw new Error('Password must be at least 8 characters long');
}
```

**Remediation:**
```typescript
function validatePassword(password: string): void {
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }

  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  const complexity = [hasUpperCase, hasLowerCase, hasNumbers, hasSpecialChar]
    .filter(Boolean).length;

  if (complexity < 3) {
    throw new Error('Password must contain at least 3 of: uppercase, lowercase, numbers, special characters');
  }

  // Check against common passwords
  if (commonPasswords.includes(password.toLowerCase())) {
    throw new Error('Password is too common');
  }
}
```

### 8. **[MEDIUM] Information Disclosure in Error Messages**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Lines:** 1731-1735
**Severity:** Medium
**Impact:** Stack traces exposed in development mode

**Current Code:**
```typescript
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});
```

**Vulnerability:** Error details exposed even in development could leak sensitive information.

**Remediation:**
```typescript
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const errorId = crypto.randomBytes(8).toString('hex');
  logger.error(`Error ${errorId}:`, {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });

  res.status(500).json({
    error: 'Internal server error',
    errorId, // For support correlation
    message: process.env.NODE_ENV === 'development' && req.ip === '127.0.0.1'
      ? err.message
      : 'An error occurred processing your request'
  });
});
```

## Low Severity Findings

### 9. **[LOW] Missing Request Size Limits**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Line:** 124
**Severity:** Low
**Impact:** Potential DoS via large payloads

**Current Code:**
```typescript
app.use(express.json());
```

**Remediation:**
```typescript
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    // Store raw body for webhook signature verification if needed
    req.rawBody = buf.toString('utf-8');
  }
}));
app.use(express.urlencoded({
  limit: '10mb',
  extended: true,
  parameterLimit: 1000
}));
```

### 10. **[LOW] Regex DoS Risk**
**File:** `/home/yeraze/Development/meshmonitor/src/server/server.ts`
**Lines:** 1203-1214
**Severity:** Low
**Impact:** ReDoS vulnerability in auto-ack regex validation

**Current Code:**
```typescript
// Check for potentially dangerous patterns
if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
  return res.status(400).json({ error: 'Regex pattern too complex' });
}
```

**Remediation:**
```typescript
import safe from 'safe-regex';

if (!safe(pattern)) {
  return res.status(400).json({ error: 'Regex pattern may cause performance issues' });
}

// Additionally, use regex timeout
const testRegex = new RegExp(pattern, 'i');
const timeout = setTimeout(() => {
  throw new Error('Regex execution timeout');
}, 100);

try {
  testRegex.test('test string');
  clearTimeout(timeout);
} catch (error) {
  clearTimeout(timeout);
  return res.status(400).json({ error: 'Invalid or unsafe regex pattern' });
}
```

## Positive Security Findings

### ✅ **Good: SQL Injection Prevention**
All database queries use parameterized statements via better-sqlite3's prepared statements. No string concatenation in queries.

### ✅ **Good: Password Hashing**
Uses bcrypt with appropriate salt rounds for password hashing.

### ✅ **Good: Session Management**
- HttpOnly cookies configured
- Secure flag configurable for production
- SameSite protection enabled
- Session rotation on authentication

### ✅ **Good: Authorization Model**
Well-structured permission system with granular resource-based access control.

### ✅ **Good: Audit Logging**
Comprehensive audit logging for security-relevant events.

## Recommendations Priority

### Immediate (Critical - Fix within 24-48 hours)
1. Implement Helmet.js for security headers
2. Fix CORS configuration to restrict origins
3. Add CSRF protection for state-changing operations

### Short-term (High - Fix within 1 week)
1. Implement rate limiting on all endpoints
2. Enforce strong session secret in production
3. Add comprehensive input validation

### Medium-term (Medium - Fix within 1 month)
1. Strengthen password requirements
2. Implement request size limits
3. Add regex safety checks
4. Sanitize error messages

### Long-term (Enhancement)
1. Implement API key authentication for programmatic access
2. Add request signing/HMAC validation for critical operations
3. Implement field-level encryption for sensitive data
4. Add security event monitoring and alerting
5. Implement automatic session timeout based on user activity
6. Add MFA/2FA support

## Testing Recommendations

1. **Security Testing Suite:**
```javascript
// Add to test suite
describe('Security Headers', () => {
  test('should set security headers', async () => {
    const response = await request(app).get('/');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toBeDefined();
  });
});
```

2. **Penetration Testing:**
- Run OWASP ZAP automated scan
- Test for SQL injection with sqlmap
- Test for XSS with XSStrike
- Check for CSRF vulnerabilities
- Verify rate limiting effectiveness

3. **Dependency Scanning:**
```bash
npm audit
npm audit fix
npx snyk test
```

## Compliance Considerations

- **GDPR:** Implement data encryption at rest for PII
- **OWASP Top 10:** Address identified vulnerabilities mapping to OWASP categories
- **PCI DSS:** If payment processing added, ensure compliance with data protection standards

## Conclusion

The MeshMonitor backend demonstrates solid foundational security practices, particularly in database security and authentication architecture. However, critical gaps exist in HTTP security headers, CORS configuration, and rate limiting that expose the application to common web vulnerabilities.

Implementing the recommended remediations, particularly the critical and high-severity findings, will significantly improve the application's security posture. The modular architecture makes it relatively straightforward to add these security controls without major refactoring.

**Overall Security Score: 6/10** (Good foundation, critical gaps need addressing)

---
*Review completed: $(date +%Y-%m-%d)*
*Reviewed version: 2.3.1*
*Next review recommended: After implementing critical fixes*