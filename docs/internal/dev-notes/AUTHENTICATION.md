# Authentication and Authorization System

## Overview

MeshMonitor implements a comprehensive authentication and authorization system supporting both local (username/password) and OpenID Connect (OIDC) authentication providers. The system uses session-based authentication with granular role-based access control (RBAC).

## Table of Contents

- [Authentication Methods](#authentication-methods)
- [User Management](#user-management)
- [Permission System](#permission-system)
- [API Endpoints](#api-endpoints)
- [Frontend Integration](#frontend-integration)
- [Security Considerations](#security-considerations)
- [OIDC Configuration](#oidc-configuration)
- [Testing](#testing)

## Authentication Methods

### Local Authentication

Local authentication uses bcrypt for password hashing with a salt round of 12.

**Features:**
- Secure password hashing using bcrypt
- Password change functionality (available in user menu for local auth users)
- Admin password reset capability
- Session-based authentication
- Can be disabled when using OIDC exclusively

**Login Flow:**
1. User submits username/password to `/api/auth/login`
2. System validates credentials using bcrypt.compare()
3. On success, creates session with user ID and role information
4. Returns user object (without password hash) and permissions

### OIDC Authentication

OpenID Connect (OIDC) integration using the `openid-client` library.

**Supported Features:**
- Authorization Code Flow with PKCE
- State and nonce validation
- ID token verification
- Auto-user creation (configurable)
- Multiple identity providers

**OIDC Flow:**
1. User initiates OIDC login via `/api/auth/oidc/login`
2. System generates PKCE parameters (code_verifier, code_challenge)
3. User redirects to identity provider
4. Identity provider redirects back to `/api/auth/oidc/callback`
5. System exchanges authorization code for ID token
6. System validates ID token and creates/updates user
7. Session is created and user is logged in

## User Management

### User Schema

```typescript
interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  authProvider: 'local' | 'oidc';
  oidcSubject: string | null;      // OIDC subject identifier
  isAdmin: boolean;
  isActive: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  createdBy: number | null;
}
```

### Admin Operations

Admins can perform the following operations via `/api/users`:

- **List Users**: `GET /api/users`
- **Get User**: `GET /api/users/:id`
- **Create User**: `POST /api/users` (local auth only)
- **Update User**: `PUT /api/users/:id`
- **Deactivate User**: `DELETE /api/users/:id`
- **Toggle Admin Status**: `PUT /api/users/:id/admin`
- **Reset Password**: `POST /api/users/:id/reset-password` (local auth only)
- **View Permissions**: `GET /api/users/:id/permissions`
- **Update Permissions**: `PUT /api/users/:id/permissions`

### Self-Service Operations

All authenticated users can:

- **View Auth Status**: `GET /api/auth/status`
- **Change Password**: `POST /api/auth/change-password` (local auth only)
- **Logout**: `POST /api/auth/logout`

## Permission System

### Resource Types

The system defines the following resources:

- `dashboard` - View statistics and system info
- `nodes` - View and manage mesh nodes
- `messages` - Send and receive mesh messages
- `settings` - Application settings
- `configuration` - Device configuration
- `info` - Telemetry and network information
- `automation` - Automated tasks and announcements

### Permission Actions

Each resource supports two actions:
- `read` - View/access the resource
- `write` - Modify the resource

### Permission Schema

```typescript
interface Permission {
  id: number;
  userId: number;
  resource: ResourceType;
  canRead: boolean;
  canWrite: boolean;
  grantedAt: number;
  grantedBy: number | null;
}
```

### Default Permissions

**Regular Users:**
- Dashboard: read-only
- Nodes: read-only
- Messages: read-only
- Info: read-only
- Settings: no access
- Configuration: no access
- Automation: no access

**Admin Users:**
- All resources: read + write access

### Permission Middleware

Three middleware functions enforce permissions:

1. **optionalAuth()**: Attaches user to request if authenticated (no enforcement)
2. **requireAuth()**: Requires valid authenticated session
3. **requirePermission(resource, action)**: Requires specific resource permission
4. **requireAdmin()**: Requires admin role

**Example Usage:**
```typescript
// Public endpoint
app.get('/api/public', optionalAuth(), handler);

// Requires authentication
app.get('/api/profile', requireAuth(), handler);

// Requires specific permission
app.get('/api/nodes', requirePermission('nodes', 'read'), handler);
app.post('/api/messages', requirePermission('messages', 'write'), handler);

// Requires admin
app.get('/api/users', requireAdmin(), handler);
```

## API Endpoints

### Authentication Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/status` | GET | None | Get current auth status |
| `/api/auth/login` | POST | None | Local authentication login |
| `/api/auth/logout` | POST | None | Logout and destroy session |
| `/api/auth/change-password` | POST | User | Change own password |
| `/api/auth/oidc/login` | GET | None | Initiate OIDC flow |
| `/api/auth/oidc/callback` | GET | None | OIDC callback handler |

### User Management Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/users` | GET | Admin | List all users |
| `/api/users/:id` | GET | Admin | Get user by ID |
| `/api/users` | POST | Admin | Create new user |
| `/api/users/:id` | PUT | Admin | Update user |
| `/api/users/:id` | DELETE | Admin | Deactivate user |
| `/api/users/:id/admin` | PUT | Admin | Toggle admin status |
| `/api/users/:id/reset-password` | POST | Admin | Reset user password |
| `/api/users/:id/permissions` | GET | Admin | Get user permissions |
| `/api/users/:id/permissions` | PUT | Admin | Update user permissions |

## Frontend Integration

### AuthContext

The `AuthContext` provides authentication state management:

```typescript
interface AuthContextType {
  authStatus: AuthStatus | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  oidcLogin: () => Promise<void>;
}
```

### Components

**UserMenu**: Displays user info and logout button
**UsersTab**: Admin-only user management interface

### Permission Checking

Frontend components can check permissions:

```typescript
const { authStatus } = useAuth();

// Check if user is admin
if (authStatus?.user?.isAdmin) {
  // Show admin features
}

// Check specific permission
if (authStatus?.permissions?.messages?.write) {
  // Show send message button
}
```

## Security Considerations

### Password Security

- Passwords hashed using bcrypt with 12 salt rounds
- Password hashes never sent to client
- Minimum password requirements should be enforced in production

### Session Security

- Sessions stored server-side (express-session)
- Session cookies use httpOnly flag (recommended)
- Session cookies use secure flag in production (HTTPS)
- Sessions invalidated on user deactivation
- Session timeout configurable via express-session

### OIDC Security

- PKCE (Proof Key for Code Exchange) required
- State parameter validated to prevent CSRF
- Nonce validated in ID token
- ID token signature verification
- Token endpoint uses client secret authentication

### API Security

- All sensitive endpoints require authentication
- Admin endpoints require admin role
- Users cannot modify their own admin status
- Users cannot delete their own account
- Password reset generates secure random passwords
- Audit logging for security events

### Input Validation

- All inputs validated and sanitized
- SQL injection prevented via parameterized queries
- XSS prevention via React's built-in escaping
- CSRF protection via same-site cookies

## OIDC Configuration

### Quick Start

To enable OIDC authentication with MeshMonitor:

1. **Register MeshMonitor in your identity provider**
2. **Configure environment variables**
3. **Restart MeshMonitor**
4. **Login and configure user permissions**

### Environment Variables

Required environment variables for OIDC:

```bash
# OIDC Configuration
OIDC_ENABLED=true                            # Required to enable OIDC
OIDC_ISSUER=https://your-identity-provider.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://your-app.com/api/auth/oidc/callback
OIDC_SCOPES="openid profile email"           # Optional, defaults to this
OIDC_AUTO_CREATE_USERS=true                  # Optional, defaults to true

# Local Authentication Control
DISABLE_LOCAL_AUTH=false                     # Optional, set to true to disable local auth (OIDC only)
```

### Docker Compose Example

```yaml
version: '3.8'
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      # Meshtastic connection
      - MESHTASTIC_NODE_IP=192.168.1.100
      - MESHTASTIC_TCP_PORT=4403

      # OIDC Configuration
      - OIDC_ENABLED=true
      - OIDC_ISSUER=https://auth.example.com/application/o/meshmonitor/
      - OIDC_CLIENT_ID=your-client-id-here
      - OIDC_CLIENT_SECRET=your-client-secret-here
      - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback

      # Optional: Disable local auth for OIDC-only mode
      # - DISABLE_LOCAL_AUTH=true

      # Session security
      - SESSION_SECRET=your-random-secret-here
    restart: unless-stopped

volumes:
  meshmonitor-data:
```

### Dual Authentication Mode

MeshMonitor supports both local and OIDC authentication simultaneously:

- **Both Enabled** (default): Users can login with either local credentials or OIDC
- **OIDC Only**: Set `DISABLE_LOCAL_AUTH=true` to force all users to use OIDC
  - Local login form will be hidden
  - `/api/auth/login` endpoint will return 403
  - Useful for enterprise SSO deployments
  - Change Password option hidden (managed by identity provider)

### Supported Identity Providers

The OIDC implementation uses OpenID Connect Discovery and supports any compliant provider:

- **Authentik** - Open-source Identity Provider
- **Keycloak** - Red Hat's open-source IAM
- **Auth0** - Cloud identity platform
- **Okta** - Enterprise identity service
- **Azure AD** - Microsoft identity platform
- **Google** - Google Workspace
- **GitHub** (via OIDC endpoint)
- Any OpenID Connect 1.0 compliant provider

### Provider Setup Examples

#### Authentik

**1. Create a new Provider:**
- Navigate to **Applications** → **Providers**
- Click **Create**
- **Provider Type**: OAuth2/OpenID Provider
- **Name**: MeshMonitor
- **Client Type**: Confidential
- **Redirect URIs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
- **Signing Key**: Select your certificate
- **Scopes**: Ensure `openid`, `email`, `profile` are selected
- Click **Finish**

**2. Create an Application:**
- Navigate to **Applications** → **Applications**
- Click **Create**
- **Name**: MeshMonitor
- **Slug**: meshmonitor
- **Provider**: Select the provider created above
- **Launch URL**: `https://meshmonitor.example.com`
- Click **Create**

**3. Copy Client Credentials:**
- Go back to your Provider settings
- Copy the **Client ID** and **Client Secret**

**4. Configure MeshMonitor:**
```yaml
environment:
  - OIDC_ENABLED=true
  - OIDC_ISSUER=https://auth.example.com/application/o/meshmonitor/
  - OIDC_CLIENT_ID=<client-id-from-authentik>
  - OIDC_CLIENT_SECRET=<client-secret-from-authentik>
  - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

**Note**: The OIDC_ISSUER URL can be found in your Authentik provider settings under "OpenID Configuration Issuer".

#### Keycloak

**1. Create a new Client:**
- Navigate to your Realm → **Clients**
- Click **Create**
- **Client Type**: OpenID Connect
- **Client ID**: `meshmonitor`
- Click **Next**

**2. Configure Client Settings:**
- **Client Authentication**: ON (for confidential client)
- **Authorization**: OFF (not needed)
- **Standard Flow**: ON
- **Direct Access Grants**: OFF
- Click **Next**

**3. Configure Redirect URIs:**
- **Valid Redirect URIs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
- **Web Origins**: `https://meshmonitor.example.com`
- Click **Save**

**4. Get Client Secret:**
- Go to the **Credentials** tab
- Copy the **Client Secret**

**5. Configure MeshMonitor:**
```yaml
environment:
  - OIDC_ENABLED=true
  - OIDC_ISSUER=https://keycloak.example.com/realms/myrealm
  - OIDC_CLIENT_ID=meshmonitor
  - OIDC_CLIENT_SECRET=<client-secret-from-keycloak>
  - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

**Note**: Replace `myrealm` with your actual Keycloak realm name.

#### Google Workspace

**1. Create OAuth 2.0 Credentials:**
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create a new project or select existing
- Navigate to **APIs & Services** → **Credentials**
- Click **Create Credentials** → **OAuth Client ID**
- **Application Type**: Web application
- **Name**: MeshMonitor

**2. Configure Authorized Redirect URIs:**
- **Authorized Redirect URIs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
- Click **Create**

**3. Copy Credentials:**
- Copy the **Client ID** and **Client Secret**

**4. Configure MeshMonitor:**
```yaml
environment:
  - OIDC_ENABLED=true
  - OIDC_ISSUER=https://accounts.google.com
  - OIDC_CLIENT_ID=<client-id>.apps.googleusercontent.com
  - OIDC_CLIENT_SECRET=<client-secret-from-google>
  - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

#### Azure AD (Microsoft Entra ID)

**1. Register Application:**
- Go to [Azure Portal](https://portal.azure.com/)
- Navigate to **Azure Active Directory** → **App Registrations**
- Click **New registration**
- **Name**: MeshMonitor
- **Supported Account Types**: Choose appropriate option
- **Redirect URI**: Web - `https://meshmonitor.example.com/api/auth/oidc/callback`
- Click **Register**

**2. Create Client Secret:**
- Navigate to **Certificates & secrets**
- Click **New client secret**
- **Description**: MeshMonitor
- **Expires**: Choose appropriate duration
- Click **Add**
- Copy the **Value** (client secret) immediately

**3. Configure API Permissions:**
- Navigate to **API permissions**
- Ensure these are granted:
  - `openid`
  - `profile`
  - `email`
  - `User.Read`

**4. Configure MeshMonitor:**
```yaml
environment:
  - OIDC_ENABLED=true
  - OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
  - OIDC_CLIENT_ID=<application-id>
  - OIDC_CLIENT_SECRET=<client-secret-from-azure>
  - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

**Note**: Replace `<tenant-id>` with your Azure AD tenant ID (found in Azure AD overview).

### First-Time Setup

1. Configure environment variables
2. Restart application to initialize OIDC
3. Login button will show "Login with OIDC" option
4. First user to login via OIDC will be created automatically
5. Promote first user to admin if needed via database or another admin

## Testing

### Unit Tests

- **User Model Tests**: `src/server/models/User.test.ts`
- **Permission Model Tests**: `src/server/models/Permission.test.ts`

### Integration Tests

- **Auth Routes Tests**: `src/server/routes/authRoutes.test.ts`
- **User Routes Tests**: `src/server/routes/userRoutes.test.ts`

### Running Tests

```bash
npm test
```

### Test Coverage

Tests cover:
- Local authentication flow
- Password hashing and verification
- Session management
- Permission checking
- Permission granting and revoking
- Default permissions
- Admin operations
- User management CRUD
- Permission boundaries
- Security constraints

## Audit Logging

All security-relevant events are logged to the audit log:

- `login_success` - Successful login
- `login_failed` - Failed login attempt
- `logout` - User logout
- `user_created` - New user created
- `oidc_user_created` - OIDC user auto-created
- `user_updated` - User information updated
- `user_deleted` - User deactivated
- `admin_status_changed` - Admin status modified
- `permissions_updated` - Permissions modified
- `password_reset` - Admin password reset
- `password_changed` - User password change

Audit logs include:
- User ID (if authenticated)
- Action type
- Resource type
- Action details (JSON)
- IP address
- Timestamp

## Best Practices

### For Administrators

1. **Initial Setup**:
   - Create admin user immediately
   - Change default admin password
   - Configure OIDC if using external identity provider

2. **User Management**:
   - Grant minimum necessary permissions
   - Review permissions regularly
   - Deactivate users instead of deleting (maintains audit trail)
   - Monitor audit logs for suspicious activity

3. **Production Deployment**:
   - Enable HTTPS (required for secure cookies)
   - Use strong session secret
   - Configure session timeout appropriately
   - Enable OIDC for enterprise SSO

### For Developers

1. **Adding New Protected Endpoints**:
   ```typescript
   // Public data
   app.get('/api/public', optionalAuth(), handler);

   // Requires authentication
   app.get('/api/profile', requireAuth(), handler);

   // Requires specific permission
   app.get('/api/resource', requirePermission('resource', 'read'), handler);

   // Requires admin
   app.get('/api/admin', requireAdmin(), handler);
   ```

2. **Adding New Resources**:
   - Update `ResourceType` in `src/types/permission.ts`
   - Add to `RESOURCES` array with description
   - Update default permissions if needed
   - Update frontend permission checks

3. **Never**:
   - Store passwords in plain text
   - Send password hashes to client
   - Skip authentication on sensitive endpoints
   - Allow users to escalate their own privileges

## Troubleshooting

### Common Issues

**OIDC Login Fails**:
- Verify OIDC_ISSUER is correct and accessible
- Check OIDC_REDIRECT_URI matches registered redirect URI
- Ensure OIDC_CLIENT_SECRET is correct
- Check browser console for errors
- Review server logs for OIDC errors

**Session Not Persisting**:
- Verify session middleware is configured
- Check cookie settings (secure, sameSite)
- Ensure session store is working
- Check for CORS issues

**Permission Denied**:
- Verify user has correct permissions
- Check if user is active
- Confirm endpoint requires correct permission level
- Review audit logs

**Password Reset Not Working**:
- Only works for local auth users
- User must exist and be active
- Admin privilege required

## Migration Guide

### Upgrading from No Auth

If migrating from an unauthenticated version:

1. Run database migration: `001_add_auth_tables.ts`
2. Create initial admin user via CLI tool
3. Configure frontend to show login page
4. Update API calls to use authenticated fetch
5. Add permission checks to frontend components
6. Test thoroughly before deployment

### Adding OIDC to Existing Local Auth

1. Configure OIDC environment variables
2. Restart application
3. OIDC login option appears automatically
4. Existing local users continue working
5. New users can authenticate via either method
6. Consider migrating users to OIDC over time

## Support

For issues or questions:
- Check server logs for detailed error messages
- Review audit logs for security events
- Consult API documentation
- Open GitHub issue with reproduction steps
