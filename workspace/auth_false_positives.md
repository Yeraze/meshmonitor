# Authentication False Positives Tracking

This document tracks vulnerabilities from the authentication exploitation queue that were determined to be false positives or out of scope.

## Out of Scope (Internal Access Required)

### AUTH-VULN-01: Session Fixation on POST /api/auth/login
**Date Tested:** 2026-02-24
**Reason:** Local authentication is completely disabled on the target application (`localAuthDisabled: true`). The vulnerability exists in the code but cannot be exploited externally because the attack vector is not exposed through the network interface.
**Evidence:**
- GET /api/auth/status returns `"localAuthDisabled": true`
- Login UI only shows "Login with OIDC" option
- POST /api/auth/login endpoint exists but rejects all requests due to disabled local auth

### AUTH-VULN-02: Session Fixation on POST /api/auth/verify-mfa
**Date Tested:** 2026-02-24
**Reason:** MFA verification endpoint requires local authentication flow to be completed first, which is disabled. Cannot reach this endpoint without first completing local login via POST /api/auth/login.
**Evidence:**
- Depends on `pendingMfaUserId` session state from local authentication
- Local authentication disabled, so this flow cannot be initiated
- Endpoint is not independently accessible

### AUTH-VULN-05: Weak Default Credentials (admin:changeme)
**Date Tested:** 2026-02-24
**Reason:** Default admin credentials cannot be tested or exploited because local authentication is disabled. Even if default password were unchanged, there is no way to submit credentials to the application.
**Evidence:**
- GET /api/auth/check-default-password returns `{"isDefaultPassword": false}`
- No username/password input in UI (OIDC-only)
- Cannot submit credentials via POST /api/auth/login (local auth disabled)

## Summary

**Total Tested:** 5 vulnerabilities
**Out of Scope:** 3 vulnerabilities (AUTH-VULN-01, AUTH-VULN-02, AUTH-VULN-05)
**Potential:** 2 vulnerabilities (AUTH-VULN-03, AUTH-VULN-04)
**Exploited:** 0 vulnerabilities

**Key Insight:** The target application's security posture is significantly improved by disabling local authentication and requiring OIDC-only authentication. This eliminates multiple potential attack vectors related to password-based authentication flows.
