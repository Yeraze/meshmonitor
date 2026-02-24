# Security Policy

## AI-Assisted Development Disclosure

MeshMonitor is almost entirely built using [Claude Code](https://claude.com/claude-code) (Anthropic's CLI coding agent), with the [Context7](https://context7.com/) MCP for up-to-date library documentation and the [Serena](https://github.com/codiumai/serena) MCP for semantic code navigation and editing.

All code is reviewed by the project maintainer before merging. Automated CI pipelines run the full test suite, TypeScript type checking, and security scanning (Trivy) on every pull request.

## Security Features

### Authentication

- **Local accounts** with bcrypt-hashed passwords (12 rounds) and minimum 8-character password enforcement
- **Multi-Factor Authentication (MFA)** via TOTP with QR code enrollment and single-use backup codes
- **OpenID Connect (OIDC)** with PKCE flow, state validation, and nonce verification for SSO integration
- **API tokens** with Bearer authentication for programmatic access; tokens are displayed once at creation and stored hashed

### Session Management

- Database-backed sessions (SQLite, PostgreSQL, or MySQL) with automatic expired session cleanup
- HttpOnly, SameSite cookies with optional Secure flag for HTTPS deployments
- Configurable session lifetime and rolling expiration
- Two-step MFA flow prevents full session creation until verification completes

### Authorization

- Granular role-based permission system with 22 distinct resources and read/write/viewOnMap actions
- Admin role with full access override
- Anonymous user support with configurable permissions
- Per-request permission verification middleware

### CSRF Protection

- Double-submit cookie pattern with 32-byte cryptographically random tokens
- Timing-safe comparison via `crypto.timingSafeEqual()` to prevent timing attacks
- Automatically skipped for Bearer token requests (not vulnerable to CSRF)

### Rate Limiting

- Separate rate limiters for API requests, authentication attempts, message sending, and device operations
- Failed-only counting on authentication to avoid penalizing legitimate users
- IPv4-mapped IPv6 address normalization for consistent IP bucketing
- Configurable limits per environment; supports reverse proxy trust

### Security Headers

- Helmet.js with strict defaults: CSP, X-Frame-Options (deny), X-Content-Type-Options (nosniff), HSTS (1 year with preload)
- Dynamic Content Security Policy that incorporates custom tile server URLs from the database
- CORS protection with configurable allowed origins

### Input Validation

- Text sanitization removing control characters and enforcing message length limits
- Channel number, node ID, and parameter range validation
- Path traversal prevention in BASE_URL configuration

### Encryption

- AES-128-CTR and AES-256-CTR decryption of Meshtastic channel traffic with proper nonce construction
- TLS/HTTPS support for data in transit

### Security Scanning

- **Duplicate key detection** identifies mesh nodes sharing the same public key (scheduled every 24 hours)
- **Low-entropy key detection** flags nodes using known weak cryptographic keys
- **Excessive packet rate detection** monitors for potential spam or DoS behavior
- Security findings exportable as CSV or JSON

### Audit Logging

- Comprehensive audit trail covering authentication events, user management, API token operations, security scans, and configuration changes
- IP address and user context capture on every audited action
- Filterable and searchable with statistics and daily activity summaries

### Access Logging

- Optional Apache Combined format access logs with daily rotation, 14-day retention, and gzip compression
- Compatible with fail2ban for automated intrusion prevention

## Reporting a Vulnerability

If you discover a security vulnerability in MeshMonitor, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. **Email:** Send details to [randall.hand@gmail.com](mailto:randall.hand@gmail.com) with the subject line "MeshMonitor Security Report"
3. **GitHub Security Advisories:** You can also use [GitHub's private vulnerability reporting](https://github.com/Yeraze/meshmonitor/security/advisories/new) to submit a report directly

### What to Include

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any relevant logs, screenshots, or proof-of-concept code
- Your suggested severity assessment (critical, high, medium, low)

### What to Expect

- An acknowledgment within 48 hours
- A follow-up with our assessment within 7 days
- We will coordinate disclosure timing with you before any public release

### Scope

The following are in scope for security reports:

- Authentication or authorization bypasses
- Cross-site scripting (XSS), CSRF, or injection vulnerabilities
- Information disclosure or data leakage
- Session management flaws
- Cryptographic weaknesses in channel decryption
- Privilege escalation

The following are generally out of scope:

- Denial of service against the Meshtastic mesh network itself (radio-layer concerns)
- Social engineering attacks
- Issues requiring physical access to the server
- Vulnerabilities in upstream dependencies (report those to the respective projects, but do let us know so we can update)

## Supported Versions

Security updates are applied to the latest release only. We recommend always running the most recent version.
