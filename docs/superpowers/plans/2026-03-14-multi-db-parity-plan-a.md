# Multi-Database Parity — Plan A: Fix Critical Crashes

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all database methods that crash or silently fail on PostgreSQL/MySQL backends, preventing runtime errors and feature outages.

**Architecture:** Each sync method that calls `this.db.prepare()` without a PG/MySQL guard gets an async equivalent (`methodNameAsync`) that uses raw `postgresPool.connect()`/`client.query()` for PostgreSQL and `mysqlPool.query()` for MySQL. Sync methods gain PG/MySQL guards that delegate to the async version (fire-and-forget for void, return stub for value methods). Callers in Express routes become `async` handlers calling the async versions.

**Tech Stack:** TypeScript, PostgreSQL (`pg` pool), MySQL (`mysql2` pool), better-sqlite3, Express 5

**Spec:** `docs/superpowers/specs/2026-03-14-multi-db-parity-design.md` — Sub-Project A

---

## Chunk 1: Custom Theme Methods

### Task 1: Add `getAllCustomThemesAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after line ~11799, after `getAllCustomThemes()`)

- [ ] **Step 1: Write `getAllCustomThemesAsync()`**

Insert after `getAllCustomThemes()` (line 11799):

```typescript
async getAllCustomThemesAsync(): Promise<DbCustomTheme[]> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(`
        SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
        FROM custom_themes
        ORDER BY name ASC
      `);
      return result.rows.map((row: any) => ({
        id: Number(row.id),
        name: row.name,
        slug: row.slug,
        definition: row.definition,
        is_builtin: row.is_builtin ? 1 : 0,
        created_by: row.created_by ? Number(row.created_by) : undefined,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      }));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(`
      SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
      FROM custom_themes
      ORDER BY name ASC
    `);
    return (rows as any[]).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      definition: row.definition,
      is_builtin: row.is_builtin ? 1 : 0,
      created_by: row.created_by ? Number(row.created_by) : undefined,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }));
  }
  return this.getAllCustomThemes();
}
```

- [ ] **Step 2: Update `getAllCustomThemes()` guard**

Replace the PG/MySQL guard in `getAllCustomThemes()` (lines 11783-11785) so it no longer returns `[]`:

```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  // Async version handles PG/MySQL - sync callers should migrate
  return [];
}
```

No change needed — the sync method already returns `[]`. Callers will be migrated to async in Task 6.

- [ ] **Step 3: Run tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests pass (no theme tests exist for PG/MySQL yet)

- [ ] **Step 4: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getAllCustomThemesAsync() for PostgreSQL/MySQL"
```

---

### Task 2: Add `getCustomThemeBySlugAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getCustomThemeBySlug()`, line ~11824)

- [ ] **Step 1: Write `getCustomThemeBySlugAsync()`**

Insert after `getCustomThemeBySlug()`:

```typescript
async getCustomThemeBySlugAsync(slug: string): Promise<DbCustomTheme | undefined> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(
        `SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
         FROM custom_themes WHERE slug = $1`,
        [slug]
      );
      if (result.rows.length === 0) return undefined;
      const row = result.rows[0];
      return {
        id: Number(row.id),
        name: row.name,
        slug: row.slug,
        definition: row.definition,
        is_builtin: row.is_builtin ? 1 : 0,
        created_by: row.created_by ? Number(row.created_by) : undefined,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      };
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(
      `SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
       FROM custom_themes WHERE slug = ?`,
      [slug]
    );
    const arr = rows as any[];
    if (arr.length === 0) return undefined;
    const row = arr[0];
    return {
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      definition: row.definition,
      is_builtin: row.is_builtin ? 1 : 0,
      created_by: row.created_by ? Number(row.created_by) : undefined,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }
  return this.getCustomThemeBySlug(slug);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getCustomThemeBySlugAsync() for PostgreSQL/MySQL"
```

---

### Task 3: Add `createCustomThemeAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `createCustomTheme()`, line ~11858)

- [ ] **Step 1: Write `createCustomThemeAsync()`**

```typescript
async createCustomThemeAsync(name: string, slug: string, definition: ThemeDefinition, userId?: number): Promise<DbCustomTheme> {
  const now = Math.floor(Date.now() / 1000);
  const definitionJson = JSON.stringify(definition);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(
        `INSERT INTO custom_themes (name, slug, definition, is_builtin, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, false, $4, $5, $6)
         RETURNING id`,
        [name, slug, definitionJson, userId || null, now, now]
      );
      const id = Number(result.rows[0].id);
      logger.debug(`✅ Created custom theme: ${name} (slug: ${slug})`);
      return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [result] = await pool.query(
      `INSERT INTO custom_themes (name, slug, definition, is_builtin, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [name, slug, definitionJson, userId || null, now, now]
    );
    const id = Number((result as any).insertId);
    logger.debug(`✅ Created custom theme: ${name} (slug: ${slug})`);
    return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
  }
  return this.createCustomTheme(name, slug, definition, userId);
}
```

- [ ] **Step 2: Add PG/MySQL guard to sync `createCustomTheme()`**

At the top of `createCustomTheme()` (line 11829), add:

```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  throw new Error('Use createCustomThemeAsync() for PostgreSQL/MySQL');
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add createCustomThemeAsync() for PostgreSQL/MySQL"
```

---

### Task 4: Add `updateCustomThemeAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `updateCustomTheme()`, line ~11907)

- [ ] **Step 1: Write `updateCustomThemeAsync()`**

```typescript
async updateCustomThemeAsync(slug: string, updates: Partial<{ name: string; definition: ThemeDefinition }>): Promise<boolean> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      // Check existence
      const existing = await client.query('SELECT id, is_builtin FROM custom_themes WHERE slug = $1', [slug]);
      if (existing.rows.length === 0) {
        logger.warn(`⚠️  Cannot update non-existent theme: ${slug}`);
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        setClauses.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.definition !== undefined) {
        setClauses.push(`definition = $${paramIndex++}`);
        values.push(JSON.stringify(updates.definition));
      }
      if (setClauses.length === 0) return true;

      setClauses.push(`updated_at = $${paramIndex++}`);
      values.push(now);
      values.push(slug);

      await client.query(
        `UPDATE custom_themes SET ${setClauses.join(', ')} WHERE slug = $${paramIndex}`,
        values
      );
      logger.debug(`✅ Updated custom theme: ${slug}`);
      return true;
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [existingRows] = await pool.query('SELECT id, is_builtin FROM custom_themes WHERE slug = ?', [slug]);
    if ((existingRows as any[]).length === 0) {
      logger.warn(`⚠️  Cannot update non-existent theme: ${slug}`);
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.definition !== undefined) {
      setClauses.push('definition = ?');
      values.push(JSON.stringify(updates.definition));
    }
    if (setClauses.length === 0) return true;

    setClauses.push('updated_at = ?');
    values.push(now);
    values.push(slug);

    await pool.query(`UPDATE custom_themes SET ${setClauses.join(', ')} WHERE slug = ?`, values);
    logger.debug(`✅ Updated custom theme: ${slug}`);
    return true;
  }
  return this.updateCustomTheme(slug, updates);
}
```

- [ ] **Step 2: Add PG/MySQL guard to sync `updateCustomTheme()`**

At the top of `updateCustomTheme()` (line 11863), add:

```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  throw new Error('Use updateCustomThemeAsync() for PostgreSQL/MySQL');
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add updateCustomThemeAsync() for PostgreSQL/MySQL"
```

---

### Task 5: Add `deleteCustomThemeAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `deleteCustomTheme()`, line ~11933)

- [ ] **Step 1: Write `deleteCustomThemeAsync()`**

```typescript
async deleteCustomThemeAsync(slug: string): Promise<boolean> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const existing = await client.query('SELECT id, is_builtin FROM custom_themes WHERE slug = $1', [slug]);
      if (existing.rows.length === 0) {
        logger.warn(`⚠️  Cannot delete non-existent theme: ${slug}`);
        return false;
      }
      if (existing.rows[0].is_builtin) {
        throw new Error('Cannot delete built-in themes');
      }
      await client.query('DELETE FROM custom_themes WHERE slug = $1', [slug]);
      logger.debug(`🗑️  Deleted custom theme: ${slug}`);
      return true;
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [existingRows] = await pool.query('SELECT id, is_builtin FROM custom_themes WHERE slug = ?', [slug]);
    if ((existingRows as any[]).length === 0) {
      logger.warn(`⚠️  Cannot delete non-existent theme: ${slug}`);
      return false;
    }
    if ((existingRows as any[])[0].is_builtin) {
      throw new Error('Cannot delete built-in themes');
    }
    await pool.query('DELETE FROM custom_themes WHERE slug = ?', [slug]);
    logger.debug(`🗑️  Deleted custom theme: ${slug}`);
    return true;
  }
  return this.deleteCustomTheme(slug);
}
```

- [ ] **Step 2: Add PG/MySQL guard to sync `deleteCustomTheme()`**

At the top of `deleteCustomTheme()` (line 11912), add:

```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  throw new Error('Use deleteCustomThemeAsync() for PostgreSQL/MySQL');
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add deleteCustomThemeAsync() for PostgreSQL/MySQL"
```

---

### Task 6: Migrate theme route callers to async

**Files:**
- Modify: `src/server/server.ts` (lines 5146-5300 — theme API routes)

All 5 theme endpoints call sync methods. Convert each handler to `async` and use the async versions.

- [ ] **Step 1: Update GET /themes (line 5146)**

Change:
```typescript
apiRouter.get('/themes', optionalAuth(), (_req, res) => {
  try {
    const themes = databaseService.getAllCustomThemes();
```

To:
```typescript
apiRouter.get('/themes', optionalAuth(), async (_req, res) => {
  try {
    const themes = await databaseService.getAllCustomThemesAsync();
```

- [ ] **Step 2: Update GET /themes/:slug (line 5157)**

Change:
```typescript
apiRouter.get('/themes/:slug', optionalAuth(), (req, res) => {
  try {
    const { slug } = req.params;
    const theme = databaseService.getCustomThemeBySlug(slug);
```

To:
```typescript
apiRouter.get('/themes/:slug', optionalAuth(), async (req, res) => {
  try {
    const { slug } = req.params;
    const theme = await databaseService.getCustomThemeBySlugAsync(slug);
```

- [ ] **Step 3: Update POST /themes (line 5174)**

Change `databaseService.getCustomThemeBySlug(slug)` to `await databaseService.getCustomThemeBySlugAsync(slug)` (duplicate check, line ~5190) and `databaseService.createCustomTheme(...)` to `await databaseService.createCustomThemeAsync(...)` (line ~5203). Make handler async.

- [ ] **Step 4: Update PUT /themes/:slug (line ~5230)**

Change `databaseService.updateCustomTheme(slug, updates)` to `await databaseService.updateCustomThemeAsync(slug, updates)` (line ~5264). Make handler async.

- [ ] **Step 5: Update DELETE /themes/:slug (line ~5280)**

Change `databaseService.getCustomThemeBySlug(slug)` to `await databaseService.getCustomThemeBySlugAsync(slug)` (line ~5290) and `databaseService.deleteCustomTheme(slug)` to `await databaseService.deleteCustomThemeAsync(slug)` (line ~5300). Make handler async.

- [ ] **Step 6: Run tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/server/server.ts
git commit -m "fix: migrate theme routes to async for PostgreSQL/MySQL support"
```

---

## Chunk 2: Audit Stats & Notification Methods

### Task 7: Add `getAuditStatsAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getAuditStats()`, line ~10044)

- [ ] **Step 1: Write `getAuditStatsAsync()`**

```typescript
async getAuditStatsAsync(days: number = 30): Promise<any> {
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const actionStats = await client.query(
        `SELECT action, COUNT(*) as count FROM audit_log WHERE timestamp >= $1 GROUP BY action ORDER BY count DESC`,
        [cutoff]
      );
      const userStats = await client.query(
        `SELECT u.username, COUNT(*) as count FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
         WHERE al.timestamp >= $1 GROUP BY al.user_id, u.username ORDER BY count DESC LIMIT 10`,
        [cutoff]
      );
      const dailyStats = await client.query(
        `SELECT to_char(to_timestamp(timestamp/1000), 'YYYY-MM-DD') as date, COUNT(*) as count
         FROM audit_log WHERE timestamp >= $1
         GROUP BY to_char(to_timestamp(timestamp/1000), 'YYYY-MM-DD')
         ORDER BY date DESC`,
        [cutoff]
      );
      const rows = actionStats.rows.map((r: any) => ({ action: r.action, count: Number(r.count) }));
      return {
        actionStats: rows,
        userStats: userStats.rows.map((r: any) => ({ username: r.username, count: Number(r.count) })),
        dailyStats: dailyStats.rows.map((r: any) => ({ date: r.date, count: Number(r.count) })),
        totalEvents: rows.reduce((sum: number, stat: any) => sum + stat.count, 0),
      };
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [actionRows] = await pool.query(
      `SELECT action, COUNT(*) as count FROM audit_log WHERE timestamp >= ? GROUP BY action ORDER BY count DESC`,
      [cutoff]
    );
    const [userRows] = await pool.query(
      `SELECT u.username, COUNT(*) as count FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
       WHERE al.timestamp >= ? GROUP BY al.user_id ORDER BY count DESC LIMIT 10`,
      [cutoff]
    );
    const [dailyRows] = await pool.query(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(timestamp/1000), '%Y-%m-%d') as date, COUNT(*) as count
       FROM audit_log WHERE timestamp >= ?
       GROUP BY DATE_FORMAT(FROM_UNIXTIME(timestamp/1000), '%Y-%m-%d')
       ORDER BY date DESC`,
      [cutoff]
    );
    const actionStats = (actionRows as any[]).map((r: any) => ({ action: r.action, count: Number(r.count) }));
    return {
      actionStats,
      userStats: (userRows as any[]).map((r: any) => ({ username: r.username, count: Number(r.count) })),
      dailyStats: (dailyRows as any[]).map((r: any) => ({ date: r.date, count: Number(r.count) })),
      totalEvents: actionStats.reduce((sum: number, stat: any) => sum + stat.count, 0),
    };
  }
  return this.getAuditStats(days);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getAuditStatsAsync() for PostgreSQL/MySQL"
```

---

### Task 8: Migrate audit stats route caller to async

**Files:**
- Modify: `src/server/routes/auditRoutes.ts` (line 86)

- [ ] **Step 1: Update caller**

Change:
```typescript
const stats = databaseService.getAuditStats(days);
```

To:
```typescript
const stats = await databaseService.getAuditStatsAsync(days);
```

Make sure the route handler is `async`. Check the handler signature — if it's `(req, res) => {`, change to `async (req, res) => {`.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/server/routes/auditRoutes.test 2>&1 | tail -20`
Expected: All audit route tests pass

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/auditRoutes.ts
git commit -m "fix: migrate audit stats route to async for PostgreSQL/MySQL"
```

---

### Task 9: Implement `checkInactiveNodes()` for PostgreSQL/MySQL

**Files:**
- Modify: `src/server/services/inactiveNodeNotificationService.ts` (line 83)

The current implementation returns early for PG/MySQL (line 86-88). Replace the early return with async queries.

- [ ] **Step 1: Replace PG/MySQL guard with async implementation**

Replace the early return block (lines 86-88) with database-agnostic queries. The method needs to:

1. Query `user_notification_preferences` for users with `notify_on_inactive_node` enabled
2. For each user, query `nodes` table for their monitored nodes that are inactive

For PG/MySQL, use the `postgresPool` / `mysqlPool`:

```typescript
// For PostgreSQL/MySQL, use async queries
if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
  await this.checkInactiveNodesAsync(thresholdHours, cooldownHours, now);
  return;
}
```

Then add a new private method `checkInactiveNodesAsync()`:

```typescript
private async checkInactiveNodesAsync(thresholdHours: number, cooldownHours: number, now: number): Promise<void> {
  const cutoffSeconds = Math.floor(now / 1000) - thresholdHours * 60 * 60;

  let users: Array<{ user_id: number; monitored_nodes: string | null }>;

  if (databaseService.drizzleDbType === 'postgres') {
    const client = await databaseService.postgresPool!.connect();
    try {
      const result = await client.query(
        `SELECT user_id, monitored_nodes FROM user_notification_preferences
         WHERE notify_on_inactive_node = true
           AND (enable_web_push = true OR enable_apprise = true)`
      );
      users = result.rows;
    } finally {
      client.release();
    }
  } else {
    const pool = databaseService.mysqlPool!;
    const [rows] = await pool.query(
      `SELECT user_id, monitored_nodes FROM user_notification_preferences
       WHERE notify_on_inactive_node = 1
         AND (enable_web_push = 1 OR enable_apprise = 1)`
    );
    users = rows as any[];
  }

  if (users.length === 0) {
    logger.debug('✅ No users have inactive node notifications enabled');
    return;
  }

  logger.debug(`🔍 Checking inactive nodes for ${users.length} user(s)`);

  for (const user of users) {
    let monitoredNodeIds: string[] = [];
    if (user.monitored_nodes) {
      try {
        monitoredNodeIds = JSON.parse(user.monitored_nodes);
      } catch (error) {
        logger.warn(`Failed to parse monitored_nodes for user ${user.user_id}:`, error);
        continue;
      }
    }

    if (monitoredNodeIds.length === 0) {
      logger.debug(`⏭️  User ${user.user_id} has no monitored nodes, skipping`);
      continue;
    }

    let inactiveNodes: Array<{ nodeNum: number; nodeId: string; longName: string; shortName: string; lastHeard: number }>;

    if (databaseService.drizzleDbType === 'postgres') {
      const client = await databaseService.postgresPool!.connect();
      try {
        const placeholders = monitoredNodeIds.map((_, i) => `$${i + 1}`).join(',');
        const result = await client.query(
          `SELECT "nodeNum", "nodeId", "longName", "shortName", "lastHeard"
           FROM nodes
           WHERE "nodeId" IN (${placeholders})
             AND "lastHeard" IS NOT NULL
             AND "lastHeard" < $${monitoredNodeIds.length + 1}
           ORDER BY "lastHeard" ASC`,
          [...monitoredNodeIds, cutoffSeconds]
        );
        inactiveNodes = result.rows.map((r: any) => ({
          nodeNum: Number(r.nodeNum),
          nodeId: r.nodeId,
          longName: r.longName,
          shortName: r.shortName,
          lastHeard: Number(r.lastHeard),
        }));
      } finally {
        client.release();
      }
    } else {
      const pool = databaseService.mysqlPool!;
      const placeholders = monitoredNodeIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT nodeNum, nodeId, longName, shortName, lastHeard
         FROM nodes
         WHERE nodeId IN (${placeholders})
           AND lastHeard IS NOT NULL
           AND lastHeard < ?
         ORDER BY lastHeard ASC`,
        [...monitoredNodeIds, cutoffSeconds]
      );
      inactiveNodes = (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        nodeId: r.nodeId,
        longName: r.longName,
        shortName: r.shortName,
        lastHeard: Number(r.lastHeard),
      }));
    }

    if (inactiveNodes.length === 0) continue;

    // Continue with the same notification logic as the SQLite path
    // (send notifications for each inactive node, respecting cooldown)
    // The rest of the method after the inactiveNodes query is the same
    // — it uses this.lastNotificationTimes and sends via notificationService
  }
}
```

**Important:** The notification-sending logic after the query is the same for all backends. Copy it from the existing SQLite path (lines ~157 onwards in the file) into the async method, or refactor to share code.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/server/services/inactiveNodeNotificationService.test 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/server/services/inactiveNodeNotificationService.ts
git commit -m "feat: implement checkInactiveNodes() for PostgreSQL/MySQL"
```

---

### Task 10: Add async `applyNodeNamePrefix` and migrate callers

**Files:**
- Modify: `src/server/utils/notificationFiltering.ts` (after line 346)
- Modify: `src/server/server.ts` (lines ~7494 and ~7692)

The sync `applyNodeNamePrefix()` calls sync `getUserNotificationPreferences()` which crashes on PG/MySQL because it uses `this.db.prepare()`. There's already an async `getUserNotificationPreferencesAsync()` at line 355.

- [ ] **Step 1: Add `applyNodeNamePrefixAsync()`**

Insert after `applyNodeNamePrefix()` (after line 346):

```typescript
export async function applyNodeNamePrefixAsync(
  userId: number | null | undefined,
  body: string,
  nodeName: string | null | undefined
): Promise<string> {
  if (!userId || !nodeName) return body;
  const prefs = await getUserNotificationPreferencesAsync(userId);
  if (!prefs || !prefs.prefixWithNodeName) return body;
  return `[${nodeName}] ${body}`;
}
```

- [ ] **Step 2: Update test notification caller (line ~7494)**

In `src/server/server.ts`, change:
```typescript
const body = applyNodeNamePrefix(userId, baseBody, localNodeName);
```
To:
```typescript
const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);
```

Add `applyNodeNamePrefixAsync` to the import from `'./utils/notificationFiltering.js'`. Make the handler async if not already.

- [ ] **Step 3: Update test Apprise notification caller (line ~7692)**

Same change:
```typescript
const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server/utils/notificationFiltering.ts src/server/server.ts
git commit -m "fix: add async applyNodeNamePrefix to prevent crashes on PostgreSQL/MySQL"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All 2953+ tests pass

- [ ] **Step 2: Verify no unguarded `this.db.prepare()` calls remain in fixed methods**

Search for any sync DB calls in theme/audit/notification methods that should have been migrated:

```bash
grep -n 'this.db.prepare' src/services/database.ts | grep -E '(CustomTheme|AuditStats)'
```

Expected: Only lines within the SQLite fallback paths

- [ ] **Step 3: Commit final state**

If any cleanup was needed, commit it.
