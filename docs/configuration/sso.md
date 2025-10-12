# SSO Setup (OpenID Connect)

MeshMonitor supports Single Sign-On (SSO) via OpenID Connect (OIDC), allowing you to integrate with enterprise identity providers like Auth0, Okta, Keycloak, Azure AD, and more.

## Overview

OIDC integration provides:

- **Centralized Authentication**: Use your existing identity provider
- **Auto-User Creation**: Automatically create users on first login
- **Authorization Code Flow with PKCE**: Secure authentication flow
- **ID Token Verification**: Validates tokens from the identity provider
- **Multiple Providers**: Support for any OIDC-compliant provider

## Prerequisites

Before configuring SSO, you need:

1. An OIDC-compliant identity provider (IdP)
2. A registered OAuth/OIDC application/client in your IdP
3. The following information from your IdP:
   - Issuer URL
   - Client ID
   - Client Secret
   - Redirect URI (callback URL)

## Configuration

### Environment Variables

Configure OIDC using these environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `OIDC_ISSUER` | Your identity provider's issuer URL | Yes |
| `OIDC_CLIENT_ID` | OAuth client ID from your IdP | Yes |
| `OIDC_CLIENT_SECRET` | OAuth client secret from your IdP | Yes |
| `OIDC_REDIRECT_URI` | Callback URL for OIDC authentication | Yes |

### Example Configuration

#### Docker Compose

```yaml
services:
  meshmonitor:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - OIDC_ISSUER=https://your-domain.auth0.com
      - OIDC_CLIENT_ID=your_client_id_here
      - OIDC_CLIENT_SECRET=your_client_secret_here
      - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
    ports:
      - "8080:8080"
```

#### Environment File (.env)

```env
MESHTASTIC_NODE_IP=192.168.1.100
OIDC_ISSUER=https://your-domain.auth0.com
OIDC_CLIENT_ID=your_client_id_here
OIDC_CLIENT_SECRET=your_client_secret_here
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

## Provider-Specific Setup

### Auth0

1. Log in to your Auth0 dashboard
2. Create a new application:
   - Type: "Regular Web Application"
   - Name: "MeshMonitor"
3. Configure the application:
   - **Allowed Callback URLs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
   - **Allowed Logout URLs**: `https://meshmonitor.example.com`
4. Get your credentials from the "Settings" tab:
   - **Domain**: `your-domain.auth0.com`
   - **Client ID**: Copy the Client ID
   - **Client Secret**: Copy the Client Secret

**Environment Variables:**

```env
OIDC_ISSUER=https://your-domain.auth0.com
OIDC_CLIENT_ID=<your-client-id>
OIDC_CLIENT_SECRET=<your-client-secret>
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

### Keycloak

1. Log in to your Keycloak admin console
2. Create a new client:
   - Client ID: `meshmonitor`
   - Client Protocol: `openid-connect`
   - Access Type: `confidential`
3. Configure the client:
   - **Valid Redirect URIs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
   - **Web Origins**: `https://meshmonitor.example.com`
4. Get your credentials from the "Credentials" tab

**Environment Variables:**

```env
OIDC_ISSUER=https://keycloak.example.com/realms/your-realm
OIDC_CLIENT_ID=meshmonitor
OIDC_CLIENT_SECRET=<your-client-secret>
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

### Azure AD (Entra ID)

1. Log in to Azure Portal
2. Navigate to Azure Active Directory → App registrations
3. Create a new registration:
   - Name: "MeshMonitor"
   - Supported account types: Choose appropriate option
   - Redirect URI: `https://meshmonitor.example.com/api/auth/oidc/callback`
4. Create a client secret in "Certificates & secrets"
5. Note your Tenant ID and Application (client) ID

**Environment Variables:**

```env
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

### Okta

1. Log in to your Okta admin dashboard
2. Create a new Web application:
   - Application type: "Web"
   - Grant type: "Authorization Code"
3. Configure the application:
   - **Sign-in redirect URIs**: `https://meshmonitor.example.com/api/auth/oidc/callback`
   - **Sign-out redirect URIs**: `https://meshmonitor.example.com`
4. Copy your Client ID and Client Secret

**Environment Variables:**

```env
OIDC_ISSUER=https://your-domain.okta.com
OIDC_CLIENT_ID=<your-client-id>
OIDC_CLIENT_SECRET=<your-client-secret>
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

### Google OAuth

1. Go to Google Cloud Console
2. Create a new project or select existing
3. Enable the Google+ API
4. Create OAuth 2.0 credentials:
   - Application type: "Web application"
   - Authorized redirect URIs: `https://meshmonitor.example.com/api/auth/oidc/callback`
5. Copy your Client ID and Client Secret

**Environment Variables:**

```env
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<your-client-secret>
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

## Authentication Flow

When OIDC is configured, users see a "Sign in with SSO" button on the login page.

### Login Process

1. User clicks "Sign in with SSO"
2. User is redirected to the identity provider
3. User authenticates with their IdP credentials
4. IdP redirects back to MeshMonitor with an authorization code
5. MeshMonitor exchanges the code for an ID token
6. User account is created/updated automatically
7. User is logged in and redirected to the dashboard

### User Attributes

MeshMonitor extracts these attributes from the ID token:

- **Username**: From `preferred_username` or `email` claim
- **Email**: From `email` claim
- **Display Name**: From `name` claim
- **OIDC Subject**: From `sub` claim (used for linking accounts)

## User Management

### Auto-User Creation

When a user logs in via OIDC for the first time:

- A new user account is automatically created
- The user is marked as using OIDC authentication
- The OIDC subject (`sub` claim) is stored for future logins

### Admin Privileges

The first user to log in via OIDC is automatically made an admin. Subsequent users are created as regular users.

To promote additional users to admin:

1. Log in as an admin
2. Navigate to User Management
3. Select the user and click "Toggle Admin"

### Disabling Local Authentication

If you want to use OIDC exclusively, you can disable local authentication and registration in the UI. However, local authentication will still be available via API for administrative purposes.

## Troubleshooting

### Redirect URI Mismatch

**Error**: "redirect_uri_mismatch" or similar

**Solution**: Ensure the `OIDC_REDIRECT_URI` exactly matches the callback URL configured in your identity provider, including:
- Protocol (http vs https)
- Port number (if not standard)
- Path (`/api/auth/oidc/callback`)

### Invalid Issuer

**Error**: "Discovery failed" or "Invalid issuer"

**Solution**:
- Verify the `OIDC_ISSUER` URL is correct
- Ensure the issuer has a publicly accessible `.well-known/openid-configuration` endpoint
- Test: `curl https://your-issuer.com/.well-known/openid-configuration`

### Token Validation Failures

**Error**: "ID token validation failed"

**Solution**:
- Check that your client secret is correct
- Verify your identity provider's token signing algorithm is supported (RS256, HS256)
- Ensure system time is synchronized (NTP)

### Users Not Being Created

If users can authenticate but don't appear in MeshMonitor:

1. Check the backend logs for errors
2. Verify the ID token contains required claims (`sub`, `email` or `preferred_username`)
3. Check database permissions

## Security Best Practices

### Use HTTPS

Always use HTTPS in production when using OIDC:

```env
OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
```

### Protect Client Secret

Never commit your client secret to version control:

- Use environment variables
- Use secret management tools (Vault, AWS Secrets Manager, etc.)
- Rotate secrets regularly

### Restrict Redirect URIs

In your identity provider, only whitelist the exact redirect URI you need. Do not use wildcards.

### Monitor Authentication Logs

Regularly review authentication logs for suspicious activity:

```bash
# Docker
docker logs meshmonitor | grep "auth"

# Kubernetes
kubectl logs -f deployment/meshmonitor | grep "auth"
```

## Combining OIDC with Local Auth

You can use both OIDC and local authentication simultaneously:

- OIDC for regular users
- Local auth for admin/service accounts

This provides a fallback if your identity provider becomes unavailable.

## Next Steps

- [Configure a reverse proxy](/configuration/reverse-proxy) for HTTPS
- [Set up production deployment](/configuration/production) with proper monitoring
- [Learn about HTTP vs HTTPS](/configuration/http-vs-https) considerations
