# MeshMonitor Permissions - Quick Reference

## Resource Types & Endpoints

| Resource | Description | Default User Access | Read Endpoints | Write Endpoints |
|----------|-------------|---------------------|-----------------|-----------------|
| **dashboard** | System statistics | Read Only | GET /api/stats | - |
| **nodes** | Node list & management | Read Only | - | POST /api/nodes/:nodeId/favorite<br>POST /api/nodes/scan-duplicate-keys<br>POST /api/nodes/refresh |
| **channel_0 - channel_7** | Individual channel access | Read Only | GET /api/channels<br>GET /api/channels/all<br>GET /api/channels/:id/export | PUT /api/channels/:id<br>POST /api/channels/:slotId/import<br>POST /api/messages/send<br>DELETE /api/messages/:id (channel)<br>DELETE /api/messages/channels/:channelId |
| **messages** | Direct message handling | Read Only | GET /api/messages/direct/:nodeId1/:nodeId2 | POST /api/messages/send<br>DELETE /api/messages/:id (DMs)<br>DELETE /api/messages/direct-messages/:nodeNum |
| **settings** | User application settings | None | - | - |
| **configuration** | Device config & imports | None | GET /api/device-config<br>GET /api/device/backup<br>POST /api/channels/decode-url<br>GET /api/backup/* | POST /api/channels/import-config<br>POST /api/backup/settings<br>DELETE /api/backup/delete/:filename<br>POST /api/system/backup<br>DELETE /api/system/backup/delete/:dirname |
| **info** | Telemetry & network info | Read Only | GET /api/route-segments/*<br>GET /api/neighbor-info*<br>GET /api/telemetry/available/nodes | DELETE /api/route-segments/record-holder |
| **automation** | Automated tasks | None | - | - |
| **connection** | Reconnect/disconnect node | Read Only | - | POST /api/connection/disconnect<br>POST /api/connection/reconnect |
| **traceroute** | Network tracing | Read Only | - | POST /api/traceroute |
| **audit** | Audit log viewing | None | GET /api/audit<br>GET /api/audit/:id<br>GET /api/audit/stats/summary | POST /api/audit/cleanup |
| **security** | Security scanning | None | GET /api/security/issues<br>GET /api/security/scanner/status<br>GET /api/security/export | POST /api/security/scanner/scan |
| **themes** | Custom themes | Read Only | - | POST /api/themes<br>PUT /api/themes/:slug<br>DELETE /api/themes/:slug |

## Key Database Tables

### Users Table
```
users (
  id, username, password_hash, email, display_name,
  auth_provider, oidc_subject, is_admin, is_active,
  password_locked, created_at, last_login_at, created_by
)
```

### Permissions Table
```
permissions (
  id, user_id, resource, can_read, can_write,
  granted_at, granted_by
)
```
- **UNIQUE(user_id, resource)** - One permission per user per resource
- **can_read/can_write** - Boolean (0 or 1)

## Permission Checking Flow

```
1. Client makes API request
   ↓
2. Middleware: requirePermission(resource, action)
   ↓
3. Get user from session OR use anonymous user
   ↓
4. Is user admin? → Yes: Allow access
   ↓ No
5. Query: SELECT can_read, can_write FROM permissions
          WHERE user_id = ? AND resource = ?
   ↓
6. Does action match (read or write)? 
   → Yes: Continue to handler
   → No: Return 403 Forbidden
```

## Default Permission Matrix

### Admin User (All Resources)
```
dashboard: R W      messages: R W       audit: R W
nodes: R W          settings: R W       security: R W
channel_0: R W      configuration: R W  themes: R W
channel_1: R W      automation: R W
channel_2: R W      connection: R W
channel_3: R W      traceroute: R W
channel_4: R W
channel_5: R W
channel_6: R W
channel_7: R W
```

### Regular User
```
dashboard: R -      messages: R -       audit: - -
nodes: R -          settings: - -       security: - -
channel_0: R -      configuration: - -  themes: R -
channel_1: R -      automation: - -
channel_2: R -      connection: R -
channel_3: R -      traceroute: R -
channel_4: R -
channel_5: R -
channel_6: R -
channel_7: R -
```

(R = Read, W = Write, - = No Access)

## Type Definitions

```typescript
// From src/types/permission.ts

export type ResourceType =
  | 'dashboard' | 'nodes' | 'messages'
  | 'settings' | 'configuration' | 'info'
  | 'automation' | 'connection' | 'traceroute'
  | 'audit' | 'security' | 'themes'
  | 'channel_0' | 'channel_1' | 'channel_2' | 'channel_3'
  | 'channel_4' | 'channel_5' | 'channel_6' | 'channel_7';

export type PermissionAction = 'read' | 'write';

// User's permission set
export type PermissionSet = Partial<{
  [K in ResourceType]: {
    read: boolean;
    write: boolean;
  };
}>;
```

## Middleware Functions

### requirePermission(resource, action)
- Checks specific permission
- Admin bypass
- Falls back to anonymous user
- Returns 403 if denied

### requireAuth()
- Requires authenticated user
- Returns 401 if not logged in

### requireAdmin()
- Requires admin role
- Returns 403 if not admin

### hasPermission(user, resource, action)
- Utility function
- Returns boolean

## API Endpoints for Permission Management

### Get User Permissions
```
GET /api/users/:userId/permissions
Returns: { permissions: PermissionSet }
Requires: Admin role
```

### Update User Permissions
```
PUT /api/users/:userId/permissions
Body: { permissions: PermissionSet }
Returns: { success: true, message: string }
Requires: Admin role
Logs to: audit_log with action='permissions_updated'
```

### Get All Users
```
GET /api/users
Returns: { users: User[] }
Requires: Admin role
```

### Update Admin Status
```
PUT /api/users/:userId/admin
Body: { isAdmin: boolean }
Returns: { success: true, message: string }
Requires: Admin role
Logs to: audit_log
```

## Important Notes

### Per-Channel Permissions (v2.17.3+)
- Each Meshtastic channel (0-7) has its own permission resource
- `channel_0` through `channel_7` allow granular access control
- Channel 0 (Primary) permissions are independent from other channels
- Reading channel list requires read permission for at least one channel
- Sending/deleting messages requires write permission for that specific channel

### Legacy 'channels' Resource
- Deprecated as of v2.17.3 (migration 024)
- Automatically migrated to individual channel_0-7 permissions
- Old 'channels' permissions are split: read → all channels read, write → all channels write

### No Node-Specific Permissions
- 'nodes' resource is global
- Cannot restrict access to specific nodes

### Admin Always Has Access
- `is_admin = 1` bypasses all permission checks
- Even if specific permissions are missing

### Audit Trail
- Permission grants logged with timestamp
- Tracks which admin granted the permission (granted_by)
- All permission changes logged to audit_log table

## File Locations

| Component | File |
|-----------|------|
| Type definitions | `/src/types/permission.ts` |
| Model operations | `/src/server/models/Permission.ts` |
| Middleware | `/src/server/auth/authMiddleware.ts` |
| User management API | `/src/server/routes/userRoutes.ts` |
| Frontend UI | `/src/components/UsersTab.tsx` |
| Database migrations | `/src/server/migrations/001-024*.ts` |
| Per-channel migration | `/src/server/migrations/024_add_per_channel_permissions.ts` |

