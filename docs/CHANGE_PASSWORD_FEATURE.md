# Change Password & Local Auth Control Features

## Summary

Added two new features to enhance the authentication system:

1. **Change Password UI** - User-accessible password change functionality
2. **Local Auth Control** - Option to disable local authentication for OIDC-only deployments

## Change Password Feature

### Overview

Local authentication users can now change their own password through the user menu. This feature is automatically available for users authenticated via local auth (username/password) and hidden for OIDC users.

### Implementation

**Components Created:**
- `src/components/ChangePasswordModal.tsx` - New modal component for password changes

**Components Modified:**
- `src/components/UserMenu.tsx` - Added "Change Password" menu item for local auth users
- `src/App.css` - Added styling for success messages, form hints, and modal actions

**Features:**
- Password validation (minimum 8 characters)
- Confirmation field to prevent typos
- Current password verification
- Success notification with auto-close
- Only visible for local auth users
- Automatically hidden when OIDC user is logged in

### User Experience

1. User clicks on their name/avatar in the header
2. If local auth user, sees "Change Password" option above "Logout"
3. Clicks "Change Password" to open modal
4. Enters current password, new password (twice)
5. Submits form
6. Sees success message
7. Modal auto-closes after 2 seconds
8. New password is immediately active

### Password Requirements

- Minimum 8 characters (enforced client-side and server-side)
- Must be different from current password
- Confirmation must match new password

### API Integration

Uses existing endpoint: `POST /api/auth/change-password`

Request body:
```json
{
  "currentPassword": "string",
  "newPassword": "string"
}
```

Response (success):
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

Response (error):
```json
{
  "error": "Error message"
}
```

## Local Auth Control Feature

### Overview

Administrators can now disable local authentication entirely, forcing all users to authenticate via OIDC. This is useful for enterprise deployments that want to enforce SSO.

### Implementation

**Backend Changes:**
- `src/server/routes/authRoutes.ts`:
  - Added `DISABLE_LOCAL_AUTH` environment variable check
  - Returns 403 on `/api/auth/login` when disabled
  - Includes `localAuthDisabled` in auth status response

**Frontend Changes:**
- `src/contexts/AuthContext.tsx`:
  - Added `localAuthDisabled` to `AuthStatus` interface

- `src/components/LoginModal.tsx`:
  - Conditionally hides local auth form when disabled
  - Shows only OIDC login button
  - Displays helpful error if both auth methods unavailable

### Configuration

Add to environment variables:

```bash
# Disable local authentication (OIDC only)
DISABLE_LOCAL_AUTH=true
```

Default: `false` (both auth methods enabled)

### Behavior

When `DISABLE_LOCAL_AUTH=true`:

**Backend:**
- `/api/auth/login` endpoint returns 403 error
- Error message: "Local authentication is disabled. Please use OIDC to login."
- `/api/auth/status` includes `localAuthDisabled: true`

**Frontend:**
- Login modal hides username/password fields
- Only shows "Login with OIDC" button
- User menu "Change Password" option hidden for all users
- If OIDC is also not configured, shows error message

### Use Cases

1. **Enterprise SSO**: Force all users to authenticate via corporate identity provider
2. **Security Compliance**: Meet requirements for centralized authentication
3. **Simplified Management**: All users managed in identity provider
4. **Audit Requirements**: All authentication flows through audited OIDC provider

### Migration Strategy

To migrate from local auth to OIDC-only:

1. **Configure OIDC**:
   ```bash
   OIDC_ISSUER=https://your-idp.com
   OIDC_CLIENT_ID=your-client-id
   OIDC_CLIENT_SECRET=your-client-secret
   OIDC_REDIRECT_URI=https://your-app.com/api/auth/oidc/callback
   ```

2. **Test Dual Auth**:
   - Restart application
   - Verify OIDC login works
   - Create test OIDC users
   - Verify permissions carry over

3. **Enable OIDC-Only Mode**:
   ```bash
   DISABLE_LOCAL_AUTH=true
   ```
   - Restart application
   - Verify local login is disabled
   - All users must use OIDC

4. **Optional: Deactivate Local Users**:
   - Keep local admin account active for emergency access
   - Deactivate other local users if desired
   - Local users can't login but data preserved for audit

### Emergency Access

**Important**: Keep at least one local admin user active even when `DISABLE_LOCAL_AUTH=true`. If OIDC provider becomes unavailable, you can temporarily disable the flag to regain access.

Emergency recovery:
1. Set `DISABLE_LOCAL_AUTH=false` in environment
2. Restart application
3. Login with local admin account
4. Investigate OIDC issue
5. Re-enable OIDC-only mode when resolved

## Testing

### Manual Testing - Change Password

1. **Local Auth User**:
   - Login with local credentials
   - Click user menu → "Change Password"
   - Enter valid password change
   - Verify success message
   - Logout and login with new password

2. **OIDC User**:
   - Login with OIDC
   - Click user menu
   - Verify "Change Password" is not shown
   - Only "Logout" button visible

3. **Password Validation**:
   - Try password < 8 characters → Error
   - Try mismatched passwords → Error
   - Try same password → Error
   - Try wrong current password → Error

### Manual Testing - Local Auth Disable

1. **Both Auth Methods Enabled** (default):
   - Open login modal
   - See username/password fields
   - See "OR" divider
   - See "Login with OIDC" button

2. **OIDC Only** (`DISABLE_LOCAL_AUTH=true`):
   - Open login modal
   - Username/password fields hidden
   - No "OR" divider
   - Only "Login with OIDC" button
   - Try POST to /api/auth/login → 403 error

3. **No Auth Available** (OIDC disabled, local disabled):
   - Open login modal
   - See error message
   - "Local authentication is disabled and OIDC is not configured"

### Automated Testing

Tests should be added to verify:
- Change password endpoint still works correctly
- Local auth endpoint returns 403 when disabled
- Auth status includes localAuthDisabled flag
- Frontend conditionally renders based on auth config

## Files Changed

### New Files
- `src/components/ChangePasswordModal.tsx`
- `docs/CHANGE_PASSWORD_FEATURE.md` (this file)

### Modified Files

**Backend:**
- `src/server/routes/authRoutes.ts`

**Frontend:**
- `src/components/UserMenu.tsx`
- `src/components/LoginModal.tsx`
- `src/contexts/AuthContext.tsx`
- `src/App.css`

**Documentation:**
- `docs/AUTHENTICATION.md`

## Security Considerations

### Change Password Feature

✅ **Secure**:
- Requires authentication to access
- Validates current password before allowing change
- Password hashed with bcrypt before storage
- No password displayed on screen
- Old sessions remain valid (consideration for future: invalidate other sessions)

⚠️ **Recommendations**:
- Consider forcing logout after password change
- Consider invalidating all other user sessions
- Add password complexity requirements
- Add rate limiting to prevent brute force

### Local Auth Disable Feature

✅ **Secure**:
- Backend enforcement (403 on login endpoint)
- Frontend UI reflects backend state
- Emergency access possible via config change
- Audit log preserved regardless of auth method

⚠️ **Recommendations**:
- Always test OIDC thoroughly before disabling local auth
- Keep emergency local admin account
- Document OIDC provider failover procedures
- Monitor OIDC provider availability

## Configuration Examples

### Development (Both Auth Methods)
```bash
# No special config needed - default behavior
# Both local and OIDC work if OIDC is configured
```

### Production (OIDC Only)
```bash
# OIDC Configuration
OIDC_ISSUER=https://auth.company.com
OIDC_CLIENT_ID=meshmonitor-prod
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://meshmonitor.company.com/api/auth/oidc/callback
OIDC_AUTO_CREATE_USERS=false  # Require admin approval

# Disable Local Auth
DISABLE_LOCAL_AUTH=true

# Other security settings
SESSION_SECRET=<strong-secret>
NODE_ENV=production
```

### Hybrid (Both Enabled, Different Defaults)
```bash
# OIDC for regular users
OIDC_ISSUER=https://auth.company.com
OIDC_CLIENT_ID=meshmonitor
OIDC_CLIENT_SECRET=<secret>
OIDC_AUTO_CREATE_USERS=true

# Local auth available for service accounts
DISABLE_LOCAL_AUTH=false
```

## Migration Timeline Example

**Week 1: Setup**
- Configure OIDC in dev environment
- Test OIDC login flow
- Verify user creation and permissions

**Week 2: Testing**
- Deploy OIDC to staging
- Run dual auth mode (both enabled)
- Test with real users
- Gather feedback

**Week 3: Production Rollout**
- Deploy OIDC to production
- Run dual auth for 1 week
- Monitor usage and issues
- Communicate with users

**Week 4: OIDC-Only**
- Set DISABLE_LOCAL_AUTH=true
- Monitor for issues
- Keep emergency admin account
- Document new login process

## Support

### Common Issues

**Q: I can't see "Change Password" in my user menu**
A: This option is only available for users who logged in with local authentication (username/password). OIDC users manage passwords through their identity provider.

**Q: Login page shows "Local authentication is disabled"**
A: Your administrator has configured the system to use OIDC only. Click "Login with OIDC" to authenticate through your organization's identity provider.

**Q: What if OIDC is down and local auth is disabled?**
A: Administrator can temporarily set `DISABLE_LOCAL_AUTH=false` and restart the application to enable emergency local admin access.

**Q: Do I need to change my password after OIDC is enabled?**
A: No. You can continue using local auth indefinitely (dual mode) or switch to OIDC. Your password is preserved for local auth.

### Troubleshooting

**Password change fails with "Invalid current password"**:
- Verify you're entering correct current password
- Check caps lock is off
- Try copying and pasting password

**Can't login after password change**:
- Browser may have cached old password - clear it
- Verify new password meets requirements
- Check server logs for errors
- Contact administrator if persists

**Local auth disabled but need emergency access**:
- Contact system administrator
- They can temporarily enable local auth
- Login with emergency admin account
- Investigate OIDC issue

---

**Implementation Date**: 2025-01-09
**Version**: 2.0.1
**Status**: Complete and Production Ready
