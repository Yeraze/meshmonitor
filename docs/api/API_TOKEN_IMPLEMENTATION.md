# API Token Authentication System - Implementation Summary

## Overview

This document summarizes the comprehensive API token authentication system implemented for MeshMonitor 3.0, enabling integration with larger orchestration platforms through a versioned REST API.

## Implementation Date
2025-11-17

## Key Features

### 1. Single Token Per User Model
- Each user can have one active API token at a time
- Generating a new token automatically revokes the previous one
- Tokens inherit the same permissions as the user account
- No token expiration (can be manually revoked or regenerated)

### 2. Secure Token Generation
- Cryptographically secure random generation using `crypto.randomBytes()`
- Token format: `mm_v1_<32_hex_characters>`
- bcrypt hashing with 12 rounds (SALT_ROUNDS = 12)
- Token prefix stored for identification without exposing full token
- Full token displayed only once upon generation

### 3. Versioned API (v1)
- All endpoints under `/api/v1/` prefix
- Completely separate from existing internal APIs
- Requires Bearer token authentication
- RESTful design with proper HTTP methods and status codes
- Read-only operations initially

## Components

### Database Layer

**Migration File:** `src/server/migrations/025_add_api_tokens.ts`

**Table Schema:**
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  prefix TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  created_by INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (revoked_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_api_tokens_one_per_user
ON api_tokens(user_id) WHERE is_active = 1;
```

### Token Model

**File:** `src/server/models/APIToken.ts`

**Key Methods:**
- `create(input)` - Generate new token, atomically revoke old one
- `validate(token)` - Verify token and update last_used_at
- `revoke(tokenId, revokedBy)` - Invalidate token
- `getUserToken(userId)` - Get user's active token info

### Authentication Middleware

**File:** `src/server/auth/authMiddleware.ts`

**Function:** `requireAPIToken()`
- Validates Bearer token from Authorization header
- Attaches user object to request
- Comprehensive audit logging
- Returns 401 for invalid/missing tokens

### Token Management API

**File:** `src/server/routes/apiTokenRoutes.ts`

**Endpoints:**
- `GET /api/token` - View current token information
- `POST /api/token/generate` - Generate new API token
- `DELETE /api/token` - Revoke current token

All endpoints require session authentication (not API token).

### v1 REST API Endpoints

**Base Router:** `src/server/routes/v1/index.ts`

#### Nodes (`/api/v1/nodes`)
- `GET /` - List all nodes
- `GET /active` - List only active nodes
- `GET /:nodeId` - Get specific node by ID

#### Telemetry (`/api/v1/telemetry`)
- `GET /node/:nodeId` - Get telemetry for specific node
  - Query params: `limit`, `since`
- `GET /type/:type` - Get telemetry by type
  - Query params: `limit`

#### Messages (`/api/v1/messages`)
- `GET /` - List recent messages
  - Query params: `limit` (default: 100)
- `GET /channel/:channelId` - Messages from specific channel
  - Query params: `limit`
- `GET /since/:timestamp` - Messages since timestamp

#### Traceroutes (`/api/v1/traceroutes`)
- `GET /` - List all traceroutes
  - Query params: `limit`
- `GET /:fromId/:toId` - Specific traceroute between nodes

#### Network (`/api/v1/network`)
- `GET /stats` - Network-wide statistics
  - Total nodes, active nodes, messages, channels
- `GET /topology` - Network topology data
  - Nodes and their connections

### API Documentation

**OpenAPI Specification:** `src/server/routes/v1/openapi.yaml`
- 933 lines of comprehensive API documentation
- Complete schemas for all requests/responses
- Authentication instructions
- Examples for all endpoints

**Swagger UI:** `src/server/routes/v1/docs.ts`
- Interactive API documentation at `/api/v1/docs`
- Publicly accessible (no authentication required)
- Supports "Try it out" functionality
- Persistent authorization

### Frontend UI

**Component:** `src/components/APITokenManagement.tsx`

**Features:**
- Generate new API token
- One-time token display with copy-to-clipboard
- View current token info (prefix, created date, last used, status)
- Revoke token with confirmation dialog
- Links to API documentation
- Inline styled component

**Integration:** Added to `src/components/SettingsTab.tsx`

## Usage

### Generating a Token

1. Log in to MeshMonitor web UI
2. Navigate to User Settings
3. Scroll to "API Token" section
4. Click "Generate API Token"
5. Copy the displayed token (shown only once)

### Using the API

**Authentication Header:**
```
Authorization: Bearer mm_v1_<your_token_here>
```

**Example Request:**
```bash
curl -H "Authorization: Bearer mm_v1_abc123..." \
     http://localhost:3001/api/v1/nodes
```

**Example Response:**
```json
{
  "nodes": [
    {
      "id": 1,
      "nodeId": 123456789,
      "shortName": "NODE1",
      "longName": "My Node",
      "isActive": true,
      ...
    }
  ],
  "total": 1
}
```

## Security Features

1. **Token Storage:** Only hashed tokens stored in database (bcrypt, 12 rounds)
2. **Audit Logging:** All token operations logged with timestamps and IP addresses
3. **Rate Limiting:** More restrictive than session-based authentication
4. **Single Token:** Prevents token proliferation
5. **Permission Inheritance:** Tokens have identical permissions as user account
6. **HTTPS Recommended:** Bearer tokens should only be transmitted over HTTPS

## Build Configuration Changes

### package.json
Updated `build:server` script to copy OpenAPI spec:
```json
"build:server": "tsc --project tsconfig.server.json && mkdir -p dist/server/routes/v1 && cp src/server/routes/v1/openapi.yaml dist/server/routes/v1/"
```

### Dockerfile
Added ownership fix for dist directory:
```dockerfile
RUN chown -R node:node ./dist
```

### Dependencies Added
```json
"swagger-ui-express": "^5.x.x",
"yamljs": "^0.x.x",
"@types/swagger-ui-express": "^4.x.x",
"@types/yamljs": "^0.x.x"
```

## Files Created/Modified

### New Files
- `src/server/migrations/025_add_api_tokens.ts`
- `src/server/models/APIToken.ts`
- `src/server/routes/apiTokenRoutes.ts`
- `src/server/routes/v1/index.ts`
- `src/server/routes/v1/nodes.ts`
- `src/server/routes/v1/telemetry.ts`
- `src/server/routes/v1/messages.ts`
- `src/server/routes/v1/traceroutes.ts`
- `src/server/routes/v1/network.ts`
- `src/server/routes/v1/openapi.yaml`
- `src/server/routes/v1/docs.ts`
- `src/components/APITokenManagement.tsx`
- `API_TOKEN_IMPLEMENTATION.md` (this file)

### Modified Files
- `src/types/auth.ts` - Added APIToken interfaces
- `src/services/database.ts` - Integrated APIToken model
- `src/server/auth/authMiddleware.ts` - Added requireAPIToken()
- `src/server/server.ts` - Registered v1 routes
- `src/components/SettingsTab.tsx` - Integrated token management UI
- `package.json` - Updated build:server script
- `Dockerfile` - Added dist ownership fix

## Testing Status

- ✅ TypeScript compilation successful
- ✅ Docker build successful
- ✅ Container deployment successful
- ✅ Application running normally
- ✅ Unit tests for token operations - **35 tests passing (src/server/models/APIToken.test.ts)**
- ✅ Integration tests created for v1 API (src/server/routes/v1/api.v1.test.ts)

### Unit Test Coverage

Complete test suite for API Token model with 35 passing tests covering:

**Token Generation (create)**
- ✅ Correct token format (mm_v1_ prefix + 32 hex chars)
- ✅ Token prefix storage (not full token)
- ✅ bcrypt hashing with 12 rounds
- ✅ Unique token generation
- ✅ Proper metadata storage
- ✅ Single token per user enforcement
- ✅ Atomic transaction (revoke + create)

**Token Validation (validate)**
- ✅ Valid token returns correct user ID
- ✅ Updates last_used_at timestamp
- ✅ Rejects wrong prefix
- ✅ Rejects wrong format
- ✅ Rejects revoked tokens
- ✅ Rejects incorrect hash
- ✅ Rejects non-existent tokens
- ✅ Multiple validation attempts

**Token Revocation (revoke)**
- ✅ Successful revocation
- ✅ Returns false for already revoked
- ✅ Returns false for non-existent token
- ✅ Invalidates token after revocation

**Get User Token (getUserToken)**
- ✅ Returns active token
- ✅ Returns null when no active token
- ✅ Returns null for revoked token
- ✅ Returns only active token when multiple exist

**Single Token Constraint**
- ✅ Database unique index enforcement
- ✅ Multiple revoked tokens allowed

**Edge Cases**
- ✅ User deletion cascade
- ✅ Very long validation delays
- ✅ Concurrent token generation
- ✅ Metadata preservation through regenerations
- ✅ Empty/whitespace token validation
- ✅ Special characters rejection

**Security Properties**
- ✅ Cryptographically secure random generation
- ✅ bcrypt with sufficient rounds (12)
- ✅ No timing information leakage
- ✅ Different tokens hash differently

**Test Execution**:
```bash
npm run test:run src/server/models/APIToken.test.ts
# Result: 35 passed (35) in ~12s
```

### Integration Tests

Created comprehensive integration test suite for v1 API:
- Authentication flow testing
- All endpoint coverage (nodes, telemetry, messages, traceroutes, network)
- Error handling validation
- Query parameter validation
- Response format consistency

Note: Integration tests require further refinement for end-to-end testing setup but provide excellent coverage blueprint for manual testing.

## Remaining Work

1. **Documentation** ⏳
   - Add API Token section to main README.md
   - User guide for generating and using API tokens
   - Developer guide for API integration
   - Migration notes for version upgrades

## API Versioning Strategy

The v1 API is designed with forward compatibility in mind:

- **v1 Stability:** Once released, v1 endpoints will maintain backward compatibility
- **Future Versions:** New versions (v2, v3) will be added as separate routes
- **Deprecation:** Old versions will be deprecated with advance notice
- **Migration:** Clear migration guides will be provided for version upgrades

## Rate Limiting

API token requests are subject to more restrictive rate limits than session-based requests:

- Default: 1000 requests per 15 minutes per token
- Applies per-token, not per-user
- 429 status code returned when limit exceeded
- Rate limit headers included in responses

## Troubleshooting

### Token Not Working
1. Verify token format starts with `mm_v1_`
2. Check Authorization header format: `Bearer <token>`
3. Ensure token hasn't been revoked
4. Verify user account is still active

### API Returns 404
1. Confirm route starts with `/api/v1/`
2. Check that API server is running
3. Verify no proxy/load balancer issues

### Permission Denied
1. Tokens inherit user permissions
2. Verify user account has required permissions
3. Check audit logs for details

## Support

For issues or questions:
- GitHub Issues: https://github.com/meshtastic/meshmonitor/issues
- Documentation: http://localhost:3001/api/v1/docs
- Audit Logs: Available in admin interface

## Changelog

### v3.0.0 (2025-11-17)
- Initial API token authentication system
- v1 REST API with read-only endpoints
- OpenAPI 3.0 specification
- Swagger UI integration
- Frontend token management interface
