# Multi-Database Parity — Plan B: Implement Missing Async Data Methods

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement async versions of all database methods that silently return empty/zero/null on PostgreSQL/MySQL, restoring full feature parity (DM history, dashboard stats, estimated positions, packet rates, telemetry counts, read tracking, cleanup).

**Architecture:** Each stub method gets an `Async` equivalent using raw `postgresPool`/`mysqlPool` queries following the established pattern. Callers in Express routes and services are migrated to call the async versions. Four sync `getLatestTelemetryForType()` callers in `meshtasticManager.ts` are migrated to the existing `getLatestTelemetryForTypeAsync()`.

**Tech Stack:** TypeScript, PostgreSQL (`pg` pool), MySQL (`mysql2` pool), better-sqlite3, Express 5

**Spec:** `docs/superpowers/specs/2026-03-14-multi-db-parity-design.md` — Sub-Project B

---

## Chunk 1: Message & Stats Methods

### Task 1: Add `getDirectMessagesAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getDirectMessages()`, line ~4607)

- [ ] **Step 1: Write `getDirectMessagesAsync()`**

```typescript
async getDirectMessagesAsync(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(
        `SELECT * FROM messages
         WHERE portnum = 1 AND channel = -1
           AND (("fromNodeId" = $1 AND "toNodeId" = $2) OR ("fromNodeId" = $2 AND "toNodeId" = $1))
         ORDER BY COALESCE("rxTime", timestamp) DESC
         LIMIT $3 OFFSET $4`,
        [nodeId1, nodeId2, limit, offset]
      );
      return result.rows.map((row: any) => this.normalizeBigInts(row));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(
      `SELECT * FROM messages
       WHERE portnum = 1 AND channel = -1
         AND ((fromNodeId = ? AND toNodeId = ?) OR (fromNodeId = ? AND toNodeId = ?))
       ORDER BY COALESCE(rxTime, timestamp) DESC
       LIMIT ? OFFSET ?`,
      [nodeId1, nodeId2, nodeId2, nodeId1, limit, offset]
    );
    return (rows as any[]).map((row: any) => this.normalizeBigInts(row));
  }
  return this.getDirectMessages(nodeId1, nodeId2, limit, offset);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getDirectMessagesAsync() for PostgreSQL/MySQL"
```

---

### Task 2: Migrate GET direct messages route to async

**Files:**
- Modify: `src/server/server.ts` (line ~2035)

- [ ] **Step 1: Update caller**

Change:
```typescript
const dbMessages = databaseService.getDirectMessages(nodeId1, nodeId2, limit + 1, offset);
```

To:
```typescript
const dbMessages = await databaseService.getDirectMessagesAsync(nodeId1, nodeId2, limit + 1, offset);
```

Ensure the route handler is `async`.

- [ ] **Step 2: Run tests and commit**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -20
git add src/server/server.ts
git commit -m "fix: migrate DM route to async for PostgreSQL/MySQL"
```

---

### Task 3: Add `getMessagesByDayAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getMessagesByDay()`, line ~4874)

- [ ] **Step 1: Write `getMessagesByDayAsync()`**

```typescript
async getMessagesByDayAsync(days: number = 7): Promise<Array<{ date: string; count: number }>> {
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(
        `SELECT to_char(to_timestamp(timestamp/1000), 'YYYY-MM-DD') as date, COUNT(*) as count
         FROM messages WHERE timestamp > $1
         GROUP BY to_char(to_timestamp(timestamp/1000), 'YYYY-MM-DD')
         ORDER BY date`,
        [cutoff]
      );
      return result.rows.map((row: any) => ({ date: row.date, count: Number(row.count) }));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(timestamp/1000), '%Y-%m-%d') as date, COUNT(*) as count
       FROM messages WHERE timestamp > ?
       GROUP BY DATE_FORMAT(FROM_UNIXTIME(timestamp/1000), '%Y-%m-%d')
       ORDER BY date`,
      [cutoff]
    );
    return (rows as any[]).map((row: any) => ({ date: row.date, count: Number(row.count) }));
  }
  return this.getMessagesByDay(days);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getMessagesByDayAsync() for PostgreSQL/MySQL"
```

---

### Task 4: Migrate GET stats route to async

**Files:**
- Modify: `src/server/server.ts` (line ~2742)

- [ ] **Step 1: Update caller**

Change:
```typescript
const messagesByDay = databaseService.getMessagesByDay(7);
```

To:
```typescript
const messagesByDay = await databaseService.getMessagesByDayAsync(7);
```

Ensure the route handler is `async`.

- [ ] **Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "fix: migrate stats route to async for PostgreSQL/MySQL"
```

---

## Chunk 2: Telemetry & Position Methods

### Task 5: Add `getAllNodesEstimatedPositionsAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getAllNodesEstimatedPositions()`, line ~5658)

- [ ] **Step 1: Write `getAllNodesEstimatedPositionsAsync()`**

```typescript
async getAllNodesEstimatedPositionsAsync(): Promise<Map<string, { latitude: number; longitude: number }>> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(`
        WITH "LatestEstimates" AS (
          SELECT "nodeId", "telemetryType", MAX(timestamp) as "maxTimestamp"
          FROM telemetry
          WHERE "telemetryType" IN ('estimated_latitude', 'estimated_longitude')
          GROUP BY "nodeId", "telemetryType"
        )
        SELECT t."nodeId", t."telemetryType", t.value
        FROM telemetry t
        INNER JOIN "LatestEstimates" le
          ON t."nodeId" = le."nodeId"
          AND t."telemetryType" = le."telemetryType"
          AND t.timestamp = le."maxTimestamp"
      `);
      return this.buildEstimatedPositionMap(result.rows);
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query(`
      WITH LatestEstimates AS (
        SELECT nodeId, telemetryType, MAX(timestamp) as maxTimestamp
        FROM telemetry
        WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
        GROUP BY nodeId, telemetryType
      )
      SELECT t.nodeId, t.telemetryType, t.value
      FROM telemetry t
      INNER JOIN LatestEstimates le
        ON t.nodeId = le.nodeId
        AND t.telemetryType = le.telemetryType
        AND t.timestamp = le.maxTimestamp
    `);
    return this.buildEstimatedPositionMap(rows as any[]);
  }
  return this.getAllNodesEstimatedPositions();
}

private buildEstimatedPositionMap(rows: Array<{ nodeId: string; telemetryType: string; value: number }>): Map<string, { latitude: number; longitude: number }> {
  const positionMap = new Map<string, { latitude: number; longitude: number }>();
  for (const row of rows) {
    const existing = positionMap.get(row.nodeId) || { latitude: 0, longitude: 0 };
    if (row.telemetryType === 'estimated_latitude') {
      existing.latitude = Number(row.value);
    } else if (row.telemetryType === 'estimated_longitude') {
      existing.longitude = Number(row.value);
    }
    positionMap.set(row.nodeId, existing);
  }
  for (const [nodeId, pos] of positionMap) {
    if (pos.latitude === 0 || pos.longitude === 0) {
      positionMap.delete(nodeId);
    }
  }
  return positionMap;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getAllNodesEstimatedPositionsAsync() for PostgreSQL/MySQL"
```

---

### Task 6: Migrate estimated positions callers to async

**Files:**
- Modify: `src/server/server.ts` (lines ~829 and ~3783)

- [ ] **Step 1: Update both callers**

At line ~829:
```typescript
const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();
```

At line ~3783:
```typescript
const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();
```

Ensure both route handlers are `async`.

- [ ] **Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "fix: migrate estimated positions to async for PostgreSQL/MySQL"
```

---

### Task 7: Add `getPacketRatesAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getPacketRates()`, line ~6030)

- [ ] **Step 1: Write `getPacketRatesAsync()`**

```typescript
async getPacketRatesAsync(
  nodeId: string,
  types: string[],
  sinceTimestamp?: number
): Promise<Record<string, Array<{ timestamp: number; ratePerMinute: number }>>> {
  const result: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};
  for (const type of types) {
    result[type] = [];
  }

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const typePlaceholders = types.map((_, i) => `$${i + 2}`).join(', ');
      const params: (string | number)[] = [nodeId, ...types];
      let query = `SELECT "telemetryType", timestamp, value FROM telemetry
                    WHERE "nodeId" = $1 AND "telemetryType" IN (${typePlaceholders})`;
      if (sinceTimestamp !== undefined) {
        params.push(sinceTimestamp);
        query += ` AND timestamp >= $${params.length}`;
      }
      query += ` ORDER BY "telemetryType", timestamp ASC`;
      const queryResult = await client.query(query, params);
      return this.calculatePacketRates(queryResult.rows, types);
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const typePlaceholders = types.map(() => '?').join(', ');
    const params: (string | number)[] = [nodeId, ...types];
    let query = `SELECT telemetryType, timestamp, value FROM telemetry
                  WHERE nodeId = ? AND telemetryType IN (${typePlaceholders})`;
    if (sinceTimestamp !== undefined) {
      params.push(sinceTimestamp);
      query += ` AND timestamp >= ?`;
    }
    query += ` ORDER BY telemetryType, timestamp ASC`;
    const [rows] = await pool.query(query, params);
    return this.calculatePacketRates(rows as any[], types);
  }
  return this.getPacketRates(nodeId, types, sinceTimestamp);
}

private calculatePacketRates(
  rows: Array<{ telemetryType: string; timestamp: number; value: number }>,
  types: string[]
): Record<string, Array<{ timestamp: number; ratePerMinute: number }>> {
  const result: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};
  for (const type of types) {
    result[type] = [];
  }

  const groupedByType: Record<string, Array<{ timestamp: number; value: number }>> = {};
  for (const row of rows) {
    if (!groupedByType[row.telemetryType]) {
      groupedByType[row.telemetryType] = [];
    }
    groupedByType[row.telemetryType].push({
      timestamp: Number(row.timestamp),
      value: Number(row.value),
    });
  }

  for (const [type, samples] of Object.entries(groupedByType)) {
    const rates: Array<{ timestamp: number; ratePerMinute: number }> = [];
    for (let i = 1; i < samples.length; i++) {
      const deltaValue = samples[i].value - samples[i - 1].value;
      const deltaTimeMs = samples[i].timestamp - samples[i - 1].timestamp;
      const deltaTimeMinutes = deltaTimeMs / 60000;
      if (deltaValue < 0) continue; // Counter reset
      if (deltaTimeMinutes > 60) continue; // Stale data
      if (deltaTimeMinutes < 0.1) continue; // Too small
      rates.push({
        timestamp: samples[i].timestamp,
        ratePerMinute: deltaValue / deltaTimeMinutes,
      });
    }
    result[type] = rates;
  }
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getPacketRatesAsync() for PostgreSQL/MySQL"
```

---

### Task 8: Migrate packet rates caller to async

**Files:**
- Modify: `src/server/server.ts` (line ~3527)

- [ ] **Step 1: Update caller**

Change:
```typescript
rates = databaseService.getPacketRates(nodeId, packetTypes, cutoffTime);
```

To:
```typescript
rates = await databaseService.getPacketRatesAsync(nodeId, packetTypes, cutoffTime);
```

Ensure route handler is `async`.

- [ ] **Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "fix: migrate packet rates route to async for PostgreSQL/MySQL"
```

---

### Task 9: Add `getTelemetryCountAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `getTelemetryCount()`, line ~4680)

- [ ] **Step 1: Write `getTelemetryCountAsync()`**

```typescript
async getTelemetryCountAsync(): Promise<number> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query('SELECT COUNT(*) as count FROM telemetry');
      return Number(result.rows[0].count);
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM telemetry');
    return Number((rows as any[])[0].count);
  }
  return this.getTelemetryCount();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add getTelemetryCountAsync() for PostgreSQL/MySQL"
```

---

### Task 10: Migrate telemetry count caller to async

**Files:**
- Modify: `src/server/routes/v1/telemetry.ts` (line ~91)

- [ ] **Step 1: Update caller**

Change:
```typescript
const count = databaseService.getTelemetryCount();
```

To:
```typescript
const count = await databaseService.getTelemetryCountAsync();
```

Ensure route handler is `async`.

- [ ] **Step 2: Commit**

```bash
git add src/server/routes/v1/telemetry.ts
git commit -m "fix: migrate v1 telemetry count to async for PostgreSQL/MySQL"
```

---

## Chunk 3: Read Tracking, Cleanup & Telemetry Caller Migration

### Task 11: Add `markMessageAsReadAsync()` and `markMessagesAsReadAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `markMessagesAsRead()`, line ~10090)

- [ ] **Step 1: Write `markMessageAsReadAsync()`**

```typescript
async markMessageAsReadAsync(messageId: string, userId: number | null): Promise<void> {
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      await client.query(
        `INSERT INTO read_messages ("userId", "messageId", "readAt")
         VALUES ($1, $2, $3)
         ON CONFLICT ("userId", "messageId") DO NOTHING`,
        [userId, messageId, now]
      );
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    await pool.query(
      `INSERT IGNORE INTO read_messages (userId, messageId, readAt)
       VALUES (?, ?, ?)`,
      [userId, messageId, now]
    );
  } else {
    this.markMessageAsRead(messageId, userId);
  }
}
```

- [ ] **Step 2: Write `markMessagesAsReadAsync()`**

```typescript
async markMessagesAsReadAsync(messageIds: string[], userId: number | null): Promise<void> {
  if (!userId || messageIds.length === 0) return;
  const now = Math.floor(Date.now() / 1000);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      // Use a transaction for batch insert
      await client.query('BEGIN');
      for (const messageId of messageIds) {
        await client.query(
          `INSERT INTO read_messages ("userId", "messageId", "readAt")
           VALUES ($1, $2, $3)
           ON CONFLICT ("userId", "messageId") DO NOTHING`,
          [userId, messageId, now]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    for (const messageId of messageIds) {
      await pool.query(
        `INSERT IGNORE INTO read_messages (userId, messageId, readAt)
         VALUES (?, ?, ?)`,
        [userId, messageId, now]
      );
    }
  } else {
    this.markMessagesAsRead(messageIds, userId);
  }
}
```

**Note:** The `ON CONFLICT` clause depends on the PK structure. The current PostgreSQL CREATE TABLE uses `PRIMARY KEY ("messageId", "userId")` which supports this. If the schema is updated per Plan C, adjust accordingly. The read_messages table may need a unique constraint on `(userId, messageId)` even with a serial `id` PK.

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add markMessageAsReadAsync/markMessagesAsReadAsync for PostgreSQL/MySQL"
```

---

### Task 12: Migrate read tracking callers to async

**Files:**
- Modify: `src/server/meshtasticManager.ts` (line ~6235)
- Modify: `src/server/server.ts` (line ~2080)

- [ ] **Step 1: Update meshtasticManager caller**

Change:
```typescript
databaseService.markMessageAsRead(messageId_str, userId);
```

To:
```typescript
databaseService.markMessageAsReadAsync(messageId_str, userId).catch(err => {
  logger.debug('Failed to mark message as read:', err);
});
```

(Fire-and-forget — this is a non-critical side effect in a packet handler)

- [ ] **Step 2: Update server.ts caller**

Change:
```typescript
databaseService.markMessagesAsRead(messageIds, userId);
```

To:
```typescript
await databaseService.markMessagesAsReadAsync(messageIds, userId);
```

Ensure route handler is `async`.

- [ ] **Step 3: Commit**

```bash
git add src/server/meshtasticManager.ts src/server/server.ts
git commit -m "fix: migrate read tracking to async for PostgreSQL/MySQL"
```

---

### Task 13: Add `cleanupOldPacketLogsAsync()` to DatabaseService

**Files:**
- Modify: `src/services/database.ts` (insert after `cleanupOldPacketLogs()`, line ~11503)

- [ ] **Step 1: Write `cleanupOldPacketLogsAsync()`**

```typescript
async cleanupOldPacketLogsAsync(): Promise<number> {
  const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
  const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (maxAgeHours * 60 * 60);

  if (this.drizzleDbType === 'postgres') {
    const client = await this.postgresPool!.connect();
    try {
      const result = await client.query(
        'DELETE FROM packet_log WHERE timestamp < $1',
        [cutoffTimestamp]
      );
      const deleted = result.rowCount ?? 0;
      logger.debug(`🧹 Cleaned up ${deleted} packet log entries older than ${maxAgeHours} hours`);
      return deleted;
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = this.mysqlPool!;
    const [result] = await pool.query(
      'DELETE FROM packet_log WHERE timestamp < ?',
      [cutoffTimestamp]
    );
    const deleted = (result as any).affectedRows ?? 0;
    logger.debug(`🧹 Cleaned up ${deleted} packet log entries older than ${maxAgeHours} hours`);
    return deleted;
  }
  return this.cleanupOldPacketLogs();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add cleanupOldPacketLogsAsync() for PostgreSQL/MySQL"
```

---

### Task 14: Migrate packet log cleanup caller to async

**Files:**
- Modify: `src/server/services/packetLogService.ts` (line ~31)

- [ ] **Step 1: Update caller**

Change:
```typescript
const deletedCount = databaseService.cleanupOldPacketLogs();
```

To:
```typescript
const deletedCount = await databaseService.cleanupOldPacketLogsAsync();
```

Ensure the calling function is `async`. If `cleanupOldPacketLogs` is called from a non-async context, wrap it:

```typescript
databaseService.cleanupOldPacketLogsAsync().then(count => {
  // log result
}).catch(err => {
  logger.debug('Failed to cleanup packet logs:', err);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/packetLogService.ts
git commit -m "fix: migrate packet log cleanup to async for PostgreSQL/MySQL"
```

---

### Task 15: Migrate `getLatestTelemetryForType()` callers to async

**Files:**
- Modify: `src/server/meshtasticManager.ts` (lines ~4323, ~4350, ~5973, ~10720)

There are 4 callers of the sync `getLatestTelemetryForType()`. An async version `getLatestTelemetryForTypeAsync()` already exists at database.ts:8010. Migrate all callers.

- [ ] **Step 1: Update SNR local telemetry caller (line ~4323)**

Change:
```typescript
const latestSnrTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'snr_local');
```

To:
```typescript
const latestSnrTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'snr_local');
```

Ensure the containing function is `async`.

- [ ] **Step 2: Update RSSI telemetry caller (line ~4350)**

Change:
```typescript
const latestRssiTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'rssi');
```

To:
```typescript
const latestRssiTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'rssi');
```

- [ ] **Step 3: Update SNR remote telemetry caller (line ~5973)**

Change:
```typescript
const latestSnrTelemetry = databaseService.getLatestTelemetryForType(nodeId, 'snr_remote');
```

To:
```typescript
const latestSnrTelemetry = await databaseService.getLatestTelemetryForTypeAsync(nodeId, 'snr_remote');
```

- [ ] **Step 4: Update uptime telemetry caller (line ~10720)**

Change:
```typescript
const uptimeTelemetry = databaseService.getLatestTelemetryForType(node.nodeId, 'uptimeSeconds');
```

To:
```typescript
const uptimeTelemetry = await databaseService.getLatestTelemetryForTypeAsync(node.nodeId, 'uptimeSeconds');
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "fix: migrate getLatestTelemetryForType callers to async for PostgreSQL/MySQL"
```

---

### Task 16: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All 2953+ tests pass

- [ ] **Step 2: Verify no stubs remain for fixed methods**

```bash
grep -n 'return \[\];\|return 0;\|return new Map();\|return;' src/services/database.ts | grep -E '(getDirectMessages|getMessagesByDay|getAllNodesEstimatedPositions|getPacketRates|getTelemetryCount|markMessage|cleanupOldPacketLogs)' | head -20
```

Expected: Only the sync method guards remain (the async versions handle the real work)

- [ ] **Step 3: Commit any cleanup**

If any adjustments were needed, commit them.
