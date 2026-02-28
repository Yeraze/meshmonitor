# Message Search Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add unified message search across channels, DMs, and MeshCore messages with filtering, permissions, and click-to-navigate.

**Architecture:** New `searchMessages()` method in `MessagesRepository` using SQL LIKE/ILIKE for the standard messages table. MeshCore search is done in-memory via `meshcoreManager.getRecentMessages()` filtered on the server. A new `GET /api/v1/messages/search` endpoint handles permission filtering. Frontend gets a `SearchModal` component triggered from the Sidebar.

**Tech Stack:** Drizzle ORM (like/ilike/sql), Express, React, i18next, vitest/supertest

---

### Task 1: Add `searchMessages` to MessagesRepository

**Files:**
- Modify: `src/db/repositories/messages.ts` (add method after `getMessagesByChannel` at line ~222)

**Step 1: Write the failing test**

Create test file `src/db/repositories/messages.search.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the search endpoint integration in Task 3.
// This task focuses on the repository method signature and SQL generation.
// For now, write a minimal type-check test that verifies the method exists.

describe('MessagesRepository.searchMessages', () => {
  it('should be exported as a method', async () => {
    // Dynamic import to verify the class has the method
    const { MessagesRepository } = await import('./messages.js');
    expect(typeof MessagesRepository.prototype.searchMessages).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/messages.search.test.ts`
Expected: FAIL — `searchMessages` is not defined on the prototype.

**Step 3: Implement `searchMessages` in MessagesRepository**

Add the following method to `MessagesRepository` in `src/db/repositories/messages.ts` after the `getMessagesByChannel` method (line ~222). Also add `like` and `ilike` to the drizzle-orm imports at the top.

Add to the imports at line 7:
```typescript
import { eq, gt, lt, and, or, desc, sql, like, ilike } from 'drizzle-orm';
```

Add the method:

```typescript
async searchMessages(options: {
  query: string;
  caseSensitive?: boolean;
  scope?: 'all' | 'channels' | 'dms';
  channels?: number[];
  fromNodeId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}): Promise<{ messages: DbMessage[]; total: number }> {
  const {
    query,
    caseSensitive = false,
    scope = 'all',
    channels: channelFilter,
    fromNodeId,
    startDate,
    endDate,
    limit = 50,
    offset = 0
  } = options;

  const searchPattern = `%${query}%`;

  if (this.isSQLite()) {
    const db = this.getSqliteDb();
    const table = messagesSqlite;

    const conditions: ReturnType<typeof eq>[] = [];

    // Text search — SQLite LIKE is case-insensitive for ASCII by default
    // For case-sensitive, use GLOB or raw sql with LIKE BINARY isn't available
    if (caseSensitive) {
      // SQLite: use raw sql for case-sensitive LIKE (pragma case_sensitive_like)
      conditions.push(sql`${table.text} LIKE ${searchPattern}`);
      // We'll wrap in a subquery with case_sensitive_like pragma alternative:
      // Actually, SQLite LIKE is case-insensitive for ASCII. For case-sensitive, use GLOB
      // But GLOB uses different wildcards (* instead of %). Let's use instr() for exact match:
      conditions.push(sql`instr(${table.text}, ${query}) > 0`);
      // Remove the LIKE condition, use only instr for case-sensitive
      conditions.pop();
      conditions.pop();
      conditions.push(sql`instr(${table.text}, ${query}) > 0`);
    } else {
      conditions.push(sql`LOWER(${table.text}) LIKE LOWER(${searchPattern})`);
    }

    // Scope filter
    if (scope === 'channels') {
      conditions.push(sql`${table.channel} >= 0`);
    } else if (scope === 'dms') {
      conditions.push(eq(table.channel, -1));
    }

    // Channel filter
    if (channelFilter && channelFilter.length > 0) {
      conditions.push(sql`${table.channel} IN (${sql.join(channelFilter.map(c => sql`${c}`), sql`, `)})`);
    }

    // Sender filter
    if (fromNodeId) {
      conditions.push(eq(table.fromNodeId, fromNodeId));
    }

    // Date range
    if (startDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) <= ${endDate}`);
    }

    // Only search messages with text content
    conditions.push(sql`${table.text} IS NOT NULL AND ${table.text} != ''`);

    const whereClause = and(...conditions);

    const messages = await db
      .select()
      .from(table)
      .where(whereClause)
      .orderBy(desc(sql`COALESCE(${table.rxTime}, ${table.timestamp})`))
      .limit(limit)
      .offset(offset);

    // Count total
    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(table)
      .where(whereClause);

    const total = Number(countResult[0]?.count ?? 0);

    return {
      messages: messages.map(m => this.normalizeBigInts(m) as DbMessage),
      total
    };
  } else if (this.isMySQL()) {
    const db = this.getMysqlDb();
    const table = messagesMysql;

    const conditions: ReturnType<typeof eq>[] = [];

    // MySQL: LIKE is case-insensitive by default with utf8 collation
    if (caseSensitive) {
      conditions.push(sql`BINARY ${table.text} LIKE ${searchPattern}`);
    } else {
      conditions.push(like(table.text, searchPattern));
    }

    if (scope === 'channels') {
      conditions.push(sql`${table.channel} >= 0`);
    } else if (scope === 'dms') {
      conditions.push(eq(table.channel, -1));
    }

    if (channelFilter && channelFilter.length > 0) {
      conditions.push(sql`${table.channel} IN (${sql.join(channelFilter.map(c => sql`${c}`), sql`, `)})`);
    }

    if (fromNodeId) {
      conditions.push(eq(table.fromNodeId, fromNodeId));
    }

    if (startDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) <= ${endDate}`);
    }

    conditions.push(sql`${table.text} IS NOT NULL AND ${table.text} != ''`);

    const whereClause = and(...conditions);

    const messages = await db
      .select()
      .from(table)
      .where(whereClause)
      .orderBy(desc(sql`COALESCE(${table.rxTime}, ${table.timestamp})`))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(table)
      .where(whereClause);

    const total = Number(countResult[0]?.count ?? 0);

    return { messages: messages as DbMessage[], total };
  } else {
    // PostgreSQL
    const db = this.getPostgresDb();
    const table = messagesPostgres;

    const conditions: ReturnType<typeof eq>[] = [];

    if (caseSensitive) {
      conditions.push(like(table.text, searchPattern));
    } else {
      conditions.push(ilike(table.text, searchPattern));
    }

    if (scope === 'channels') {
      conditions.push(sql`${table.channel} >= 0`);
    } else if (scope === 'dms') {
      conditions.push(eq(table.channel, -1));
    }

    if (channelFilter && channelFilter.length > 0) {
      conditions.push(sql`${table.channel} IN (${sql.join(channelFilter.map(c => sql`${c}`), sql`, `)})`);
    }

    if (fromNodeId) {
      conditions.push(eq(table.fromNodeId, fromNodeId));
    }

    if (startDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`COALESCE(${table.rxTime}, ${table.timestamp}) <= ${endDate}`);
    }

    conditions.push(sql`${table.text} IS NOT NULL AND ${table.text} != ''`);

    const whereClause = and(...conditions);

    const messages = await db
      .select()
      .from(table)
      .where(whereClause)
      .orderBy(desc(sql`COALESCE(${table.rxTime}, ${table.timestamp})`))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(table)
      .where(whereClause);

    const total = Number(countResult[0]?.count ?? 0);

    return { messages: messages as DbMessage[], total };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/messages.search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/repositories/messages.ts src/db/repositories/messages.search.test.ts
git commit -m "feat: add searchMessages method to MessagesRepository"
```

---

### Task 2: Expose Search Through DatabaseService

**Files:**
- Modify: `src/services/database.ts` (add `searchMessagesAsync` method)

**Step 1: Add the `searchMessagesAsync` method to DatabaseService**

Find the existing message methods section (around line ~4196 near `getMessagesByChannel`). Add after the message methods block:

```typescript
async searchMessagesAsync(options: {
  query: string;
  caseSensitive?: boolean;
  scope?: 'all' | 'channels' | 'dms';
  channels?: number[];
  fromNodeId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}): Promise<{ messages: DbMessage[]; total: number }> {
  if (this.messagesRepo) {
    return this.messagesRepo.searchMessages(options);
  }
  // Fallback: shouldn't happen if repo is initialized
  return { messages: [], total: 0 };
}
```

**Step 2: Verify build compiles**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: expose searchMessagesAsync through DatabaseService facade"
```

---

### Task 3: Add Search API Endpoint

**Files:**
- Modify: `src/server/routes/v1/messages.ts` (add GET /search route)
- Create: `src/server/routes/v1/messages.search.test.ts` (API tests)

**Step 1: Write the failing test**

Create `src/server/routes/v1/messages.search.test.ts`:

```typescript
/**
 * Message Search API Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const VALID_TEST_TOKEN = 'mm_v1_test_token_12345678901234567890';
const TEST_USER_ID = 1;

const searchResults = [
  {
    id: 'msg-1',
    fromNodeId: '!abcd0001',
    fromNodeNum: 2882400001,
    toNodeId: '!abcd0002',
    toNodeNum: 2882400002,
    text: 'hello world',
    channel: 0,
    timestamp: 1709000000,
    rxTime: 1709000001,
    createdAt: 1709000001
  },
  {
    id: 'msg-2',
    fromNodeId: '!abcd0002',
    fromNodeNum: 2882400002,
    toNodeId: '!abcd0001',
    toNodeNum: 2882400001,
    text: 'hello back',
    channel: 0,
    timestamp: 1709000100,
    rxTime: 1709000101,
    createdAt: 1709000101
  }
];

// Mock database service
vi.mock('../../../services/database.js', () => ({
  default: {
    db: null,
    apiTokenModel: {
      validate: vi.fn(async (token: string) => token === VALID_TEST_TOKEN ? TEST_USER_ID : null),
      updateLastUsed: vi.fn()
    },
    findUserByIdAsync: vi.fn().mockResolvedValue({
      id: TEST_USER_ID,
      username: 'testuser',
      isAdmin: true,
      passwordHash: 'hash',
      salt: 'salt',
      createdAt: Date.now()
    }),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({
      resources: {},
      isAdmin: true
    }),
    searchMessagesAsync: vi.fn().mockResolvedValue({
      messages: searchResults,
      total: 2
    }),
    getMessagesByChannel: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockReturnValue([]),
    getMessagesAfterTimestamp: vi.fn().mockReturnValue([]),
    drizzleDbType: 'sqlite'
  }
}));

// Mock meshtasticManager
vi.mock('../../meshtasticManager.js', () => ({
  default: {
    sendMessage: vi.fn(),
    getConnectionStatus: vi.fn().mockReturnValue('connected')
  }
}));

// Mock meshcoreManager
vi.mock('../../meshcoreManager.js', () => ({
  default: {
    getRecentMessages: vi.fn().mockReturnValue([]),
    isConnected: vi.fn().mockReturnValue(false)
  }
}));

// Mock rate limiter
vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: any, _res: any, next: any) => next()
}));

// Mock messageQueueService
vi.mock('../../messageQueueService.js', () => ({
  messageQueueService: { queueMessage: vi.fn() }
}));

// Now import after mocks
const { default: databaseService } = await import('../../../services/database.js');

describe('GET /api/v1/messages/search', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    // Import after mocks
    const { default: v1Router } = await import('../../v1Router.js');
    app.use('/api/v1', v1Router);
  });

  it('should require q parameter', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should return search results', async () => {
    const res = await request(app)
      .get('/api/v1/messages/search?q=hello')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('should pass caseSensitive option', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&caseSensitive=true')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);

    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ caseSensitive: true })
    );
  });

  it('should pass scope filter', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&scope=channels')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);

    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'channels' })
    );
  });

  it('should pass date range filters', async () => {
    await request(app)
      .get('/api/v1/messages/search?q=hello&startDate=1709000000&endDate=1709100000')
      .set('Authorization', `Bearer ${VALID_TEST_TOKEN}`);

    expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: 1709000000,
        endDate: 1709100000
      })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/routes/v1/messages.search.test.ts`
Expected: FAIL — search endpoint doesn't exist yet (404).

**Step 3: Implement the search endpoint**

Add the following route in `src/server/routes/v1/messages.ts` before the `router.get('/:messageId'` route (before the catch-all param route). Also import `meshcoreManager`:

Add import near the top (after line 15):
```typescript
import meshcoreManager from '../../meshcoreManager.js';
```

Add the route handler after the existing `router.get('/')` handler:

```typescript
/**
 * GET /api/v1/messages/search
 * Search messages across channels and DMs
 *
 * Query parameters:
 * - q: string (required) - Search text
 * - caseSensitive: boolean - Case-sensitive search (default: false)
 * - scope: 'all' | 'channels' | 'dms' | 'meshcore' - Message scope (default: 'all')
 * - channels: string - Comma-separated channel IDs
 * - fromNodeId: string - Filter by sender node ID
 * - startDate: number - Unix timestamp for earliest message
 * - endDate: number - Unix timestamp for latest message
 * - limit: number - Max results (default: 50, max: 100)
 * - offset: number - Pagination offset (default: 0)
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    const { q, caseSensitive, scope, channels, fromNodeId, startDate, endDate, limit, offset } = req.query;

    // Validate required parameter
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Search query parameter "q" is required'
      });
    }

    const searchQuery = q.trim();
    const isCaseSensitive = caseSensitive === 'true';
    const searchScope = (scope as string) || 'all';
    const maxLimit = Math.min(parseInt(limit as string) || 50, 100);
    const searchOffset = parseInt(offset as string) || 0;

    // Parse channel filter
    let channelFilter: number[] | undefined;
    if (channels && typeof channels === 'string') {
      channelFilter = channels.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }

    // Parse date filters
    const startDateNum = startDate ? parseInt(startDate as string) : undefined;
    const endDateNum = endDate ? parseInt(endDate as string) : undefined;

    // Get accessible channels for permission filtering
    const accessibleChannels = await getAccessibleChannels(userId, isAdmin);

    // Build results array
    const results: any[] = [];
    let total = 0;

    // Search standard messages (unless scope is meshcore-only)
    if (searchScope !== 'meshcore') {
      // Determine which channels to search based on permissions and scope
      let effectiveChannelFilter = channelFilter;

      if (accessibleChannels !== null) {
        const accessibleArray = Array.from(accessibleChannels);

        if (effectiveChannelFilter) {
          // Intersect requested channels with accessible channels
          effectiveChannelFilter = effectiveChannelFilter.filter(c => accessibleChannels.has(c));
        } else {
          // Search only accessible channels
          effectiveChannelFilter = accessibleArray;
        }
      }

      const searchResult = await databaseService.searchMessagesAsync({
        query: searchQuery,
        caseSensitive: isCaseSensitive,
        scope: searchScope === 'meshcore' ? 'all' : (searchScope as 'all' | 'channels' | 'dms'),
        channels: effectiveChannelFilter,
        fromNodeId: fromNodeId as string | undefined,
        startDate: startDateNum,
        endDate: endDateNum,
        limit: maxLimit,
        offset: searchOffset
      });

      results.push(...searchResult.messages.map(m => ({ ...m, source: 'standard' })));
      total += searchResult.total;
    }

    // Search MeshCore messages (in-memory filter)
    if ((searchScope === 'all' || searchScope === 'meshcore') && meshcoreManager.isConnected()) {
      // Check meshcore permission
      const hasMeshcoreAccess = isAdmin || (accessibleChannels === null);

      if (hasMeshcoreAccess) {
        const allMeshcoreMessages = meshcoreManager.getRecentMessages(1000);
        const filtered = allMeshcoreMessages.filter(m => {
          if (!m.text) return false;

          const textMatch = isCaseSensitive
            ? m.text.includes(searchQuery)
            : m.text.toLowerCase().includes(searchQuery.toLowerCase());

          if (!textMatch) return false;

          // Date filter
          if (startDateNum && m.timestamp < startDateNum) return false;
          if (endDateNum && m.timestamp > endDateNum) return false;

          // fromNodeId filter (match against fromPublicKey for MeshCore)
          if (fromNodeId && m.fromPublicKey !== fromNodeId) return false;

          return true;
        });

        total += filtered.length;
        // Apply pagination (after standard messages)
        const meshcoreSlice = filtered.slice(0, Math.max(0, maxLimit - results.length));
        results.push(...meshcoreSlice.map(m => ({ ...m, source: 'meshcore' })));
      }
    }

    res.json({
      success: true,
      count: results.length,
      total,
      data: results
    });
  } catch (error) {
    logger.error('Error searching messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to search messages'
    });
  }
});
```

**IMPORTANT**: This route MUST be placed before the `router.get('/:messageId')` route, otherwise Express will match `/search` as a `:messageId` parameter.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/routes/v1/messages.search.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/routes/v1/messages.ts src/server/routes/v1/messages.search.test.ts
git commit -m "feat: add GET /api/v1/messages/search endpoint with permission filtering"
```

---

### Task 4: Add `searchMessages` to Frontend ApiService

**Files:**
- Modify: `src/services/api.ts` (add `searchMessages` method to `ApiService` class)

**Step 1: Add the method to ApiService**

Add near the existing message methods (after `getDirectMessages`, around line ~530):

```typescript
async searchMessages(params: {
  q: string;
  caseSensitive?: boolean;
  scope?: 'all' | 'channels' | 'dms' | 'meshcore';
  channels?: number[];
  fromNodeId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}): Promise<{
  success: boolean;
  count: number;
  total: number;
  data: Array<{
    id: string;
    text: string;
    fromNodeId?: string;
    fromNodeNum?: number;
    fromPublicKey?: string;
    toNodeId?: string;
    toNodeNum?: number;
    toPublicKey?: string;
    channel?: number;
    timestamp: number;
    rxTime?: number;
    source: 'standard' | 'meshcore';
  }>;
}> {
  await this.ensureBaseUrl();
  const queryParams = new URLSearchParams();
  queryParams.set('q', params.q);
  if (params.caseSensitive) queryParams.set('caseSensitive', 'true');
  if (params.scope) queryParams.set('scope', params.scope);
  if (params.channels?.length) queryParams.set('channels', params.channels.join(','));
  if (params.fromNodeId) queryParams.set('fromNodeId', params.fromNodeId);
  if (params.startDate) queryParams.set('startDate', String(params.startDate));
  if (params.endDate) queryParams.set('endDate', String(params.endDate));
  if (params.limit) queryParams.set('limit', String(params.limit));
  if (params.offset) queryParams.set('offset', String(params.offset));

  const response = await fetch(
    `${this.baseUrl}/api/v1/messages/search?${queryParams.toString()}`,
    { credentials: 'include' }
  );
  if (!response.ok) throw new Error('Failed to search messages');
  return response.json();
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/api.ts
git commit -m "feat: add searchMessages method to frontend ApiService"
```

---

### Task 5: Add i18n Translation Keys

**Files:**
- Modify: `public/locales/en.json` (add search-related keys)

**Step 1: Add translation keys**

Add the following keys to `public/locales/en.json` (find a good location, e.g., after the existing nav keys):

```json
"nav.search": "Search",
"search.title": "Search Messages",
"search.placeholder": "Search for text in messages...",
"search.button": "Search",
"search.case_sensitive": "Case Sensitive",
"search.scope": "Scope",
"search.scope_all": "All Messages",
"search.scope_channels": "Channels Only",
"search.scope_dms": "Direct Messages Only",
"search.scope_meshcore": "MeshCore Only",
"search.channels_filter": "Channels",
"search.sender_filter": "Sender",
"search.date_from": "From Date",
"search.date_to": "To Date",
"search.results_count": "{{count}} result(s) found",
"search.results_count_of": "Showing {{count}} of {{total}} results",
"search.no_results": "No messages found matching your search.",
"search.loading": "Searching...",
"search.load_more": "Load More",
"search.channel_label": "Channel {{name}}",
"search.dm_label": "DM with {{name}}",
"search.meshcore_label": "MeshCore",
"search.error": "Search failed. Please try again.",
"search.min_length": "Enter at least 2 characters to search."
```

**Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add i18n translation keys for message search"
```

---

### Task 6: Create SearchModal Component

**Files:**
- Create: `src/components/SearchModal/SearchModal.tsx`
- Create: `src/components/SearchModal/SearchModal.css`

**Step 1: Create `SearchModal.css`**

Create `src/components/SearchModal/SearchModal.css`:

```css
.search-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 10001;
  padding-top: 10vh;
}

.search-modal {
  background: var(--ctp-base);
  border-radius: 12px;
  width: 90%;
  max-width: 700px;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ctp-surface0);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.search-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--ctp-surface0);
}

.search-modal-header h2 {
  margin: 0;
  color: var(--ctp-text);
  font-size: 1.25rem;
}

.search-modal-close {
  background: none;
  border: none;
  font-size: 1.5rem;
  color: var(--ctp-subtext0);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.search-modal-close:hover {
  color: var(--ctp-text);
}

.search-modal-body {
  padding: 1rem 1.5rem;
  overflow-y: auto;
  flex: 1;
}

.search-input-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.search-input-row input[type="text"] {
  flex: 1;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--ctp-surface1);
  background: var(--ctp-mantle);
  color: var(--ctp-text);
  font-size: 1rem;
}

.search-input-row input[type="text"]::placeholder {
  color: var(--ctp-subtext0);
}

.search-input-row input[type="text"]:focus {
  outline: none;
  border-color: var(--ctp-blue);
}

.search-submit-btn {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  border: none;
  background: var(--ctp-blue);
  color: var(--ctp-base);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.search-submit-btn:hover {
  background: var(--ctp-sapphire);
}

.search-submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--ctp-surface0);
}

.search-filter-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.search-filter-group label {
  font-size: 0.8rem;
  color: var(--ctp-subtext0);
}

.search-filter-group select,
.search-filter-group input[type="date"] {
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--ctp-surface1);
  background: var(--ctp-mantle);
  color: var(--ctp-text);
  font-size: 0.85rem;
}

.search-case-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--ctp-subtext1);
  cursor: pointer;
  user-select: none;
  align-self: flex-end;
}

.search-case-toggle input[type="checkbox"] {
  accent-color: var(--ctp-blue);
}

.search-results-header {
  font-size: 0.85rem;
  color: var(--ctp-subtext0);
  margin-bottom: 0.5rem;
}

.search-result-item {
  padding: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--ctp-surface0);
  margin-bottom: 0.5rem;
  cursor: pointer;
  transition: background 0.15s;
}

.search-result-item:hover {
  background: var(--ctp-surface0);
}

.search-result-meta {
  display: flex;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: var(--ctp-subtext0);
  margin-bottom: 0.25rem;
}

.search-result-source {
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: var(--ctp-surface1);
  font-size: 0.75rem;
}

.search-result-text {
  color: var(--ctp-text);
  font-size: 0.9rem;
  line-height: 1.4;
}

.search-result-text mark {
  background: var(--ctp-yellow);
  color: var(--ctp-base);
  border-radius: 2px;
  padding: 0 2px;
}

.search-load-more {
  display: block;
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--ctp-surface1);
  background: transparent;
  color: var(--ctp-blue);
  cursor: pointer;
  font-size: 0.9rem;
}

.search-load-more:hover {
  background: var(--ctp-surface0);
}

.search-empty,
.search-error {
  text-align: center;
  padding: 2rem;
  color: var(--ctp-subtext0);
  font-size: 0.9rem;
}

.search-error {
  color: var(--ctp-red);
}

@media (max-width: 768px) {
  .search-modal-overlay {
    padding-top: 0;
    align-items: stretch;
  }

  .search-modal {
    width: 100%;
    max-width: 100%;
    max-height: 100dvh;
    border-radius: 0;
  }

  .search-filters {
    flex-direction: column;
  }
}
```

**Step 2: Create `SearchModal.tsx`**

Create `src/components/SearchModal/SearchModal.tsx`:

```tsx
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api.js';
import './SearchModal.css';

interface SearchResult {
  id: string;
  text: string;
  fromNodeId?: string;
  fromNodeNum?: number;
  fromPublicKey?: string;
  toNodeId?: string;
  toNodeNum?: number;
  toPublicKey?: string;
  channel?: number;
  timestamp: number;
  rxTime?: number;
  source: 'standard' | 'meshcore';
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToMessage: (result: SearchResult) => void;
  channels: Array<{ id: number; name: string }>;
  nodes: Array<{ nodeId: string; longName: string; shortName: string }>;
}

const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  onNavigateToMessage,
  channels,
  nodes
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<'all' | 'channels' | 'dms' | 'meshcore'>('all');
  const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
  const [fromNodeId, setFromNodeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const doSearch = useCallback(async (offset = 0) => {
    if (query.trim().length < 2) return;

    setLoading(true);
    setError('');

    try {
      const params: Parameters<typeof apiService.searchMessages>[0] = {
        q: query.trim(),
        caseSensitive,
        scope,
        limit: 50,
        offset
      };

      if (selectedChannels.length > 0) {
        params.channels = selectedChannels;
      }
      if (fromNodeId) {
        params.fromNodeId = fromNodeId;
      }
      if (startDate) {
        params.startDate = Math.floor(new Date(startDate).getTime() / 1000);
      }
      if (endDate) {
        params.endDate = Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000);
      }

      const response = await apiService.searchMessages(params);

      if (offset === 0) {
        setResults(response.data);
      } else {
        setResults(prev => [...prev, ...response.data]);
      }
      setTotal(response.total);
      setHasSearched(true);
    } catch {
      setError(t('search.error'));
    } finally {
      setLoading(false);
    }
  }, [query, caseSensitive, scope, selectedChannels, fromNodeId, startDate, endDate, t]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(0);
  };

  const handleLoadMore = () => {
    doSearch(results.length);
  };

  const handleResultClick = (result: SearchResult) => {
    onNavigateToMessage(result);
    onClose();
  };

  const highlightText = (text: string, searchQuery: string) => {
    if (!searchQuery) return text;

    const flags = caseSensitive ? 'g' : 'gi';
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, flags));

    return parts.map((part, i) => {
      const isMatch = caseSensitive
        ? part === searchQuery
        : part.toLowerCase() === searchQuery.toLowerCase();
      return isMatch ? <mark key={i}>{part}</mark> : part;
    });
  };

  const getResultLabel = (result: SearchResult): string => {
    if (result.source === 'meshcore') {
      return t('search.meshcore_label');
    }
    if (result.channel === -1) {
      const node = nodes.find(n => n.nodeId === result.fromNodeId || n.nodeId === result.toNodeId);
      return t('search.dm_label', { name: node?.longName || node?.shortName || result.fromNodeId || 'Unknown' });
    }
    const ch = channels.find(c => c.id === result.channel);
    return t('search.channel_label', { name: ch?.name || `${result.channel}` });
  };

  const getNodeName = (nodeId?: string): string => {
    if (!nodeId) return 'Unknown';
    const node = nodes.find(n => n.nodeId === nodeId);
    return node?.longName || node?.shortName || nodeId;
  };

  const formatTimestamp = (ts: number): string => {
    // Handle both seconds and milliseconds timestamps
    const date = new Date(ts < 1e12 ? ts * 1000 : ts);
    return date.toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div className="search-modal-overlay" onClick={onClose}>
      <div className="search-modal" onClick={e => e.stopPropagation()}>
        <div className="search-modal-header">
          <h2>{t('search.title')}</h2>
          <button className="search-modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="search-modal-body">
          <form onSubmit={handleSubmit}>
            <div className="search-input-row">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('search.placeholder')}
              />
              <button
                type="submit"
                className="search-submit-btn"
                disabled={loading || query.trim().length < 2}
              >
                {loading ? t('search.loading') : t('search.button')}
              </button>
            </div>
          </form>

          <div className="search-filters">
            <label className="search-case-toggle">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={e => setCaseSensitive(e.target.checked)}
              />
              {t('search.case_sensitive')}
            </label>

            <div className="search-filter-group">
              <label>{t('search.scope')}</label>
              <select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
                <option value="all">{t('search.scope_all')}</option>
                <option value="channels">{t('search.scope_channels')}</option>
                <option value="dms">{t('search.scope_dms')}</option>
                <option value="meshcore">{t('search.scope_meshcore')}</option>
              </select>
            </div>

            {(scope === 'all' || scope === 'channels') && channels.length > 0 && (
              <div className="search-filter-group">
                <label>{t('search.channels_filter')}</label>
                <select
                  value={selectedChannels.length > 0 ? String(selectedChannels[0]) : ''}
                  onChange={e => {
                    const val = e.target.value;
                    setSelectedChannels(val ? [parseInt(val)] : []);
                  }}
                >
                  <option value="">{t('search.scope_all')}</option>
                  {channels.map(ch => (
                    <option key={ch.id} value={ch.id}>{ch.name || `Channel ${ch.id}`}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="search-filter-group">
              <label>{t('search.sender_filter')}</label>
              <select value={fromNodeId} onChange={e => setFromNodeId(e.target.value)}>
                <option value="">{t('search.scope_all')}</option>
                {nodes.map(n => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.longName || n.shortName}
                  </option>
                ))}
              </select>
            </div>

            <div className="search-filter-group">
              <label>{t('search.date_from')}</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>

            <div className="search-filter-group">
              <label>{t('search.date_to')}</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {error && <div className="search-error">{error}</div>}

          {hasSearched && !error && (
            <>
              <div className="search-results-header">
                {total > 0
                  ? t('search.results_count_of', { count: results.length, total })
                  : t('search.no_results')
                }
              </div>

              {results.map(result => (
                <div
                  key={`${result.source}-${result.id}`}
                  className="search-result-item"
                  onClick={() => handleResultClick(result)}
                >
                  <div className="search-result-meta">
                    <span className="search-result-source">{getResultLabel(result)}</span>
                    <span>{getNodeName(result.fromNodeId || result.fromPublicKey)}</span>
                    <span>{formatTimestamp(result.rxTime || result.timestamp)}</span>
                  </div>
                  <div className="search-result-text">
                    {highlightText(result.text || '', query)}
                  </div>
                </div>
              ))}

              {results.length < total && (
                <button
                  className="search-load-more"
                  onClick={handleLoadMore}
                  disabled={loading}
                >
                  {loading ? t('search.loading') : t('search.load_more')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchModal;
```

**Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/SearchModal/SearchModal.tsx src/components/SearchModal/SearchModal.css
git commit -m "feat: add SearchModal component with filters and results display"
```

---

### Task 7: Add Search Trigger to Sidebar

**Files:**
- Modify: `src/components/Sidebar.tsx` (add search icon button)

**Step 1: Update `SidebarProps` interface**

Add `onSearchClick` callback to the `SidebarProps` interface in `src/components/Sidebar.tsx`:

```typescript
interface SidebarProps {
  // ... existing props ...
  onSearchClick?: () => void;
}
```

Add it to the destructured props:

```typescript
const Sidebar: React.FC<SidebarProps> = ({
  // ... existing props ...
  onSearchClick,
  meshcoreEnabled
}) => {
```

**Step 2: Add search button to the sidebar nav**

After the main section `<SectionHeader>` and before the `<NavItem id="nodes">` (around line 146), add a search button. Since search isn't a "tab" but an action, add it as a standalone button at the top of the main section:

Insert after `<SectionHeader title={t('nav.section_main')} />` (line 144) and before `<div className="sidebar-section">` (line 145):

```tsx
{onSearchClick && (
  <div className="sidebar-section">
    <button
      className="sidebar-nav-item"
      onClick={() => {
        if (!isCollapsed && !isPinned) setIsCollapsed(true);
        onSearchClick();
      }}
      title={isCollapsed ? t('nav.search') : ''}
    >
      <span className="nav-icon">🔍</span>
      {!isCollapsed && <span className="nav-label">{t('nav.search')}</span>}
    </button>
  </div>
)}
```

**Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: add search button to sidebar navigation"
```

---

### Task 8: Integrate SearchModal into App.tsx

**Files:**
- Modify: `src/App.tsx` (add SearchModal state, navigation handler)

**Step 1: Understand current App.tsx structure**

Read `src/App.tsx` to understand how tabs are managed, how channels/nodes are passed, and how to add the search modal integration.

**Step 2: Add SearchModal integration**

Import the SearchModal and add state management:

At the top of App.tsx, add:
```typescript
import SearchModal from './components/SearchModal/SearchModal.js';
```

Add state for the search modal:
```typescript
const [isSearchOpen, setIsSearchOpen] = useState(false);
```

Add a handler for navigating to a search result:
```typescript
const handleNavigateToMessage = useCallback((result: any) => {
  if (result.source === 'meshcore') {
    setActiveTab('meshcore');
  } else if (result.channel === -1) {
    // DM — switch to messages tab and select the DM conversation
    setActiveTab('messages');
    // Set the selected DM node so MessagesTab shows the right conversation
    if (result.fromNodeId) {
      setSelectedDMNode(result.fromNodeId);
    }
  } else {
    // Channel message — switch to channels tab and select the channel
    setActiveTab('channels');
    if (result.channel !== undefined) {
      setSelectedChannel(result.channel);
    }
  }
}, []);
```

Pass `onSearchClick` to Sidebar:
```tsx
<Sidebar
  // ... existing props ...
  onSearchClick={() => setIsSearchOpen(true)}
/>
```

Render the SearchModal (after the Sidebar in the JSX):
```tsx
<SearchModal
  isOpen={isSearchOpen}
  onClose={() => setIsSearchOpen(false)}
  onNavigateToMessage={handleNavigateToMessage}
  channels={channels.map(c => ({ id: c.id ?? 0, name: c.name ?? '' }))}
  nodes={processedNodes.map(n => ({
    nodeId: n.nodeId || n.node_id_hex || '',
    longName: n.longName || n.long_name || '',
    shortName: n.shortName || n.short_name || ''
  }))}
/>
```

**NOTE:** The exact prop names for channels and nodes will depend on what's available in App.tsx state. Verify the actual variable names by reading the file. Adjust `channels`, `processedNodes`, `setSelectedDMNode`, `setSelectedChannel`, and `setActiveTab` to match the actual state variable names found in App.tsx.

**Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Test manually**

Run the dev server and verify:
1. Search icon appears in sidebar
2. Clicking it opens the search modal
3. Typing a query and pressing Enter triggers search
4. Results display with highlighted text
5. Clicking a result closes modal and navigates to the correct tab

**Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: integrate SearchModal into App with navigation support"
```

---

### Task 9: Add Keyboard Shortcut (Ctrl+K / Cmd+K)

**Files:**
- Modify: `src/App.tsx` (add global keyboard shortcut)

**Step 1: Add keyboard shortcut handler**

In App.tsx, add a `useEffect` for the keyboard shortcut:

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+K or Cmd+K to open search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      setIsSearchOpen(prev => !prev);
    }
  };
  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, []);
```

**Step 2: Verify it works**

Run dev server, press Ctrl+K — search modal should toggle.

**Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add Ctrl+K keyboard shortcut to toggle search modal"
```

---

### Task 10: Write SearchModal Component Test

**Files:**
- Create: `src/components/SearchModal/SearchModal.test.tsx`

**Step 1: Write the test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SearchModal from './SearchModal.js';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, any>) => {
      const translations: Record<string, string> = {
        'search.title': 'Search Messages',
        'search.placeholder': 'Search for text in messages...',
        'search.button': 'Search',
        'search.case_sensitive': 'Case Sensitive',
        'search.scope': 'Scope',
        'search.scope_all': 'All Messages',
        'search.scope_channels': 'Channels Only',
        'search.scope_dms': 'Direct Messages Only',
        'search.scope_meshcore': 'MeshCore Only',
        'search.no_results': 'No messages found matching your search.',
        'search.loading': 'Searching...',
        'search.error': 'Search failed. Please try again.',
        'search.min_length': 'Enter at least 2 characters to search.',
        'search.channels_filter': 'Channels',
        'search.sender_filter': 'Sender',
        'search.date_from': 'From Date',
        'search.date_to': 'To Date',
        'search.results_count_of': `Showing ${params?.count} of ${params?.total} results`,
        'search.load_more': 'Load More',
        'search.channel_label': `Channel ${params?.name}`,
        'search.dm_label': `DM with ${params?.name}`,
        'search.meshcore_label': 'MeshCore'
      };
      return translations[key] || key;
    }
  })
}));

// Mock API service
vi.mock('../../services/api.js', () => ({
  default: {
    searchMessages: vi.fn(),
    ensureBaseUrl: vi.fn()
  }
}));

const { default: apiService } = await import('../../services/api.js');

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onNavigateToMessage: vi.fn(),
  channels: [
    { id: 0, name: 'Primary' },
    { id: 1, name: 'Secondary' }
  ],
  nodes: [
    { nodeId: '!abcd0001', longName: 'Test Node 1', shortName: 'TN1' },
    { nodeId: '!abcd0002', longName: 'Test Node 2', shortName: 'TN2' }
  ]
};

describe('SearchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render when isOpen is true', () => {
    render(<SearchModal {...defaultProps} />);
    expect(screen.getByText('Search Messages')).toBeInTheDocument();
  });

  it('should not render when isOpen is false', () => {
    render(<SearchModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Search Messages')).not.toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', () => {
    render(<SearchModal {...defaultProps} />);
    fireEvent.click(screen.getByText('×'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('should call onClose when overlay is clicked', () => {
    render(<SearchModal {...defaultProps} />);
    fireEvent.click(document.querySelector('.search-modal-overlay')!);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('should disable search button when query is too short', () => {
    render(<SearchModal {...defaultProps} />);
    const button = screen.getByText('Search');
    expect(button).toBeDisabled();
  });

  it('should enable search button when query is long enough', () => {
    render(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search for text in messages...');
    fireEvent.change(input, { target: { value: 'hello' } });
    const button = screen.getByText('Search');
    expect(button).not.toBeDisabled();
  });

  it('should perform search on form submit', async () => {
    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      count: 1,
      total: 1,
      data: [{
        id: 'msg-1',
        text: 'hello world',
        fromNodeId: '!abcd0001',
        channel: 0,
        timestamp: 1709000000,
        source: 'standard'
      }]
    });

    render(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search for text in messages...');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(apiService.searchMessages).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'hello' })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument();
    });
  });

  it('should navigate on result click', async () => {
    const resultData = {
      id: 'msg-1',
      text: 'hello world',
      fromNodeId: '!abcd0001',
      channel: 0,
      timestamp: 1709000000,
      source: 'standard' as const
    };

    (apiService.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      count: 1,
      total: 1,
      data: [resultData]
    });

    render(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search for text in messages...');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument();
    });

    fireEvent.click(document.querySelector('.search-result-item')!);
    expect(defaultProps.onNavigateToMessage).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
```

**Step 2: Run the test**

Run: `npx vitest run src/components/SearchModal/SearchModal.test.tsx`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/SearchModal/SearchModal.test.tsx
git commit -m "test: add SearchModal component tests"
```

---

### Task 11: Run Full Test Suite and Fix Issues

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass. If any fail, investigate and fix.

**Step 2: Run TypeScript build check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.server.json`
Expected: No type errors.

**Step 3: Run lint**

Run: `npx eslint src/components/SearchModal/ src/db/repositories/messages.ts src/server/routes/v1/messages.ts src/services/api.ts`
Expected: No lint errors. Fix any that appear.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve any test/lint/type issues from search feature"
```

---

### Task 12: Manual Integration Test and Final Commit

**Step 1: Build and start the dev container**

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d
```

**Step 2: Verify the search feature end-to-end**

1. Open `http://localhost:8080/meshmonitor`
2. Click the search icon (🔍) in the sidebar
3. Type a search query and press Enter
4. Verify results display with highlighting
5. Click a result and verify navigation works
6. Test filters: case sensitivity, scope, date range
7. Test with Ctrl+K keyboard shortcut

**Step 3: Clean up any issues found during testing**

**Step 4: Final commit with all integration fixes**

```bash
git add -A
git commit -m "feat: complete message search feature with modal, API, and navigation"
```
