# Production Deployment Checklist - Security Fixes

## What Will Break in Production

### ❌ CRITICAL: CSRF Protection

**All POST/PUT/DELETE/PATCH requests will fail with 403 "CSRF token required"**

The frontend currently makes **dozens** of mutation requests without CSRF tokens:

#### Authentication & User Management
- Login/logout (App.tsx)
- Password changes (ChangePasswordModal.tsx)
- User creation/deletion (UsersTab.tsx)

#### Settings & Configuration
- Settings updates (SettingsTab.tsx)
- Traceroute interval (SettingsContext.tsx)
- Telemetry favorites (TelemetryGraphs.tsx, Dashboard.tsx)

#### Automation Features
- Auto-acknowledge toggle (AutoAcknowledgeSection.tsx)
- Auto-announce toggle (AutoAnnounceSection.tsx)
- Auto-traceroute settings (AutoTracerouteSection.tsx)

#### Device Operations
- Send messages (services/api.ts - sendMessage)
- Request traceroutes (services/api.ts - requestTraceroute)
- Configuration updates (ConfigurationTab.tsx)
- Reboot device (services/api.ts - rebootDevice)

#### Data Management
- Delete nodes (services/api.ts - deleteNode)
- Clear old messages/telemetry/traceroutes (services/api.ts)

**Total Impact**: ~30+ different API endpoints will break

---

## Required Frontend Changes

### 1. Fetch CSRF Token on App Initialization

**File**: `src/App.tsx`

Add to the `useEffect` that checks authentication:

```typescript
useEffect(() => {
  const initializeAuth = async () => {
    try {
      // Fetch CSRF token
      const csrfResponse = await fetch('/api/csrf-token', {
        credentials: 'include'
      });
      const { csrfToken } = await csrfResponse.json();

      // Store token (in state, context, or localStorage)
      sessionStorage.setItem('csrfToken', csrfToken);

      // Then check auth status
      const response = await fetch('/api/auth/status', {
        credentials: 'include'
      });
      // ... rest of auth check
    } catch (error) {
      console.error('Failed to initialize:', error);
    }
  };

  initializeAuth();
}, []);
```

### 2. Update All Mutation Requests

**Option A**: Create a wrapper function in `src/services/api.ts`:

```typescript
// Add at top of api.ts
const getCsrfToken = () => sessionStorage.getItem('csrfToken') || '';

// Create wrapper for authenticated fetch
async function fetchWithCsrf(url: string, options: RequestInit = {}) {
  const csrfToken = getCsrfToken();

  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
      'X-CSRF-Token': csrfToken,
    },
  });
}
```

**Option B**: Create an Axios instance with interceptor:

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const csrfToken = sessionStorage.getItem('csrfToken');
  if (csrfToken) {
    config.headers['X-CSRF-Token'] = csrfToken;
  }
  return config;
});
```

### 3. Handle CSRF Token Refresh

Add error handling for 403 CSRF errors:

```typescript
// In fetch wrapper or Axios interceptor
if (response.status === 403 && error.message.includes('CSRF')) {
  // Refresh token
  const csrfResponse = await fetch('/api/csrf-token', {
    credentials: 'include'
  });
  const { csrfToken } = await csrfResponse.json();
  sessionStorage.setItem('csrfToken', csrfToken);

  // Retry original request
  return fetchWithCsrf(url, options);
}
```

---

## What Won't Break

### ✅ Working Features

1. **GET Requests**: All read operations work fine
   - View dashboard
   - View nodes
   - View messages/telemetry
   - View settings
   - SSE streams

2. **Authentication Status Check**: `/api/auth/status` is exempt from CSRF

3. **Rate Limiting**:
   - Development: 10,000 req/15min (effectively unlimited)
   - Production: 1,000 req/15min (~1 req/sec) - adequate for real-time app

4. **CORS**: Properly configured with whitelist

5. **Security Headers**: All working without breaking functionality
   - Development: No HSTS, no upgrade-insecure-requests (HTTP works)
   - Production: Full HSTS, upgrade-insecure-requests (HTTPS required)

---

## Deployment Steps

### Step 1: Frontend Updates (REQUIRED)

1. Implement CSRF token fetching in App initialization
2. Create `fetchWithCsrf` wrapper or Axios instance
3. Update all POST/PUT/DELETE/PATCH requests to use wrapper
4. Add CSRF error handling with retry logic
5. Test all mutation operations

**Files to Update**:
- `src/App.tsx` - CSRF initialization
- `src/services/api.ts` - Add wrapper function
- All components making mutations (see list above)

### Step 2: Backend Configuration (REQUIRED for Production)

**Environment Variables**:
```bash
# REQUIRED in production - app will fail to start without this
SESSION_SECRET=$(openssl rand -hex 32)

# Required for CORS
ALLOWED_ORIGINS=https://your-domain.com

# Required for secure cookies
COOKIE_SECURE=true
NODE_ENV=production

# If behind reverse proxy (nginx, Caddy, etc.)
TRUST_PROXY=1
```

### Step 3: Test in Development

1. Build frontend with CSRF support
2. Deploy to dev environment
3. Test ALL mutation operations:
   - [ ] Login/logout
   - [ ] Send message
   - [ ] Update settings
   - [ ] Toggle automations
   - [ ] Configure device
   - [ ] Delete nodes
   - [ ] Request traceroute
   - [ ] Change password

### Step 4: Deploy to Production

1. Set all required environment variables
2. Deploy backend with security fixes
3. Deploy frontend with CSRF support
4. Verify HTTPS is working
5. Test critical workflows

---

## Timeline Estimate

**Frontend CSRF Integration**: 4-6 hours
- 1 hour: Set up CSRF token management
- 2-3 hours: Update all fetch calls
- 1-2 hours: Testing and debugging

**Backend Testing**: 1-2 hours
- Verify all endpoints work with CSRF
- Test rate limiting under load
- Verify security headers

**Total**: 1 working day for complete integration

---

## Rollback Plan

If issues occur in production:

1. **Quick Fix**: Temporarily disable CSRF protection
   ```typescript
   // In src/server/server.ts
   // Comment out CSRF middleware
   // app.use(csrfTokenMiddleware);
   ```

2. **Better Fix**: Make CSRF optional via environment variable
   ```typescript
   if (process.env.ENABLE_CSRF !== 'false') {
     app.use(csrfTokenMiddleware);
     apiRouter.get('/csrf-token', csrfTokenEndpoint);
   }
   ```

3. **Proper Fix**: Complete frontend integration (recommended)

---

## Security vs Usability Trade-offs

### Current Configuration (Good for Real-time Apps)

**Rate Limiting**:
- ✅ Allows SSE/polling
- ✅ Prevents brute force
- ✅ Won't block legitimate users
- ⚠️ Could allow low-rate DoS

**CSRF Protection**:
- ✅ Prevents cross-site attacks
- ✅ Session-based (no cookies to manage)
- ⚠️ Requires frontend integration

**CORS**:
- ✅ Whitelist-based
- ✅ Configurable per environment
- ⚠️ Must configure ALLOWED_ORIGINS

### Recommendations

1. **Deploy backend WITHOUT frontend changes to staging first**
   - Test what breaks
   - Verify rate limits are acceptable
   - Check security headers

2. **Add CSRF token support to frontend in parallel**
   - Can develop/test against staging
   - Deploy when ready

3. **Consider phased rollout**
   - Deploy security headers first (non-breaking)
   - Deploy rate limiting second (mostly non-breaking)
   - Deploy CSRF last (breaking, requires frontend)

---

## Testing Checklist

### Development Environment
- [ ] Application loads over HTTP
- [ ] No SSL protocol errors
- [ ] Can send messages without rate limiting
- [ ] SSE streams work continuously
- [ ] Telemetry polling works

### Production Environment
- [ ] Application loads over HTTPS
- [ ] All mutation operations work with CSRF
- [ ] Rate limits are acceptable under normal use
- [ ] Security headers present (verify with securityheaders.com)
- [ ] CORS allows only intended origins

---

## Monitoring After Deployment

Watch for:

1. **403 CSRF errors** in logs
   - Indicates missing CSRF integration
   - Check `logger.warn` messages in csrf.ts

2. **429 Rate Limit errors**
   - May need to adjust production limits
   - Check if legitimate users being blocked

3. **CORS errors**
   - Verify ALLOWED_ORIGINS is correct
   - Check for blocked origins in logs

4. **Session issues**
   - Verify SESSION_SECRET is set and stable
   - Check cookie settings match environment

---

## Documentation Updates Needed

After deployment, update:

1. **README.md**: Add CSRF token requirement
2. **API Documentation**: Document X-CSRF-Token header requirement
3. **Development Guide**: How to work with CSRF in dev
4. **Deployment Guide**: Environment variable requirements

---

**Bottom Line**: The backend is production-ready with all security fixes. The frontend needs CSRF token integration (1 day of work) before deploying to production. Everything else works as expected.
