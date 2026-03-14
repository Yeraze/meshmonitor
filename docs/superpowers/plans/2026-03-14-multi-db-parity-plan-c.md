# Multi-Database Parity — Plan C: Schema Drift Cleanup

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `postgres-create.ts` and `mysql-create.ts` CREATE TABLE statements with the Drizzle ORM schema definitions so fresh installs have correct schemas. No runtime code changes, no migrations.

**Architecture:** Only modifies the initial database creation scripts. Existing deployments use migrations which have already been applied. This only affects fresh installations (first-time PostgreSQL or MySQL setup).

**Tech Stack:** TypeScript, PostgreSQL DDL, MySQL DDL, Drizzle ORM schemas

**Spec:** `docs/superpowers/specs/2026-03-14-multi-db-parity-design.md` — Sub-Project C

---

## Reference: Drizzle Schema Definitions

All Drizzle schemas are in `src/db/schema/`:
- `notifications.ts` — `readMessagesPostgres` (lines 92-97), `readMessagesMysql` (lines 136-141)
- `misc.ts` — `systemBackupHistoryPostgres` (lines 52-63), `systemBackupHistoryMysql` (lines 214-225), `userMapPreferencesPostgres` (lines 102-111), `userMapPreferencesMysql` (lines 238-247), `customThemesPostgres` (lines 78-87), `customThemesMysql` (lines 227-236)

---

## Chunk 1: Fix All Four Tables

### Task 1: Fix `read_messages` table in postgres-create.ts

**Files:**
- Modify: `src/db/schema/postgres-create.ts` (lines ~222-227)

**Current PostgreSQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS read_messages (
  "messageId" TEXT NOT NULL,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "readAt" BIGINT NOT NULL,
  PRIMARY KEY ("messageId", "userId")
);
```

**Drizzle schema expects:**
```typescript
export const readMessagesPostgres = pgTable('read_messages', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  messageId: pgText('messageId').notNull(),
  readAt: pgBigint('readAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update PostgreSQL CREATE TABLE**

Replace the existing `read_messages` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS read_messages (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "messageId" TEXT NOT NULL,
  "readAt" BIGINT NOT NULL
);
```

**Changes:** Added `id SERIAL PRIMARY KEY`, removed composite PK, reordered columns to match Drizzle.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/postgres-create.ts
git commit -m "fix: align read_messages CREATE TABLE with Drizzle schema (PostgreSQL)"
```

---

### Task 2: Fix `read_messages` table in mysql-create.ts

**Files:**
- Modify: `src/db/schema/mysql-create.ts` (lines ~238-245)

**Current MySQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS read_messages (
  messageId VARCHAR(255) NOT NULL,
  visitorKey VARCHAR(255) NOT NULL,
  userId INT,
  readAt BIGINT NOT NULL,
  PRIMARY KEY (messageId, visitorKey),
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Drizzle schema expects:**
```typescript
export const readMessagesMysql = mysqlTable('read_messages', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  messageId: myVarchar('messageId', { length: 64 }).notNull(),
  readAt: myBigint('readAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update MySQL CREATE TABLE**

Replace the existing `read_messages` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS read_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  messageId VARCHAR(64) NOT NULL,
  readAt BIGINT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Changes:** Added `id AUTO_INCREMENT PRIMARY KEY`, removed `visitorKey`, made `userId` NOT NULL, changed `messageId` to `VARCHAR(64)`, removed composite PK.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/mysql-create.ts
git commit -m "fix: align read_messages CREATE TABLE with Drizzle schema (MySQL)"
```

---

### Task 3: Fix `system_backup_history` table in postgres-create.ts

**Files:**
- Modify: `src/db/schema/postgres-create.ts` (lines ~305-315)

**Current PostgreSQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS system_backup_history (
  id SERIAL PRIMARY KEY,
  dirname TEXT NOT NULL UNIQUE,
  timestamp BIGINT NOT NULL,
  type TEXT NOT NULL,
  size BIGINT NOT NULL,
  table_count INTEGER NOT NULL,
  meshmonitor_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  "createdAt" BIGINT NOT NULL
);
```

**Drizzle schema expects:**
```typescript
export const systemBackupHistoryPostgres = pgTable('system_backup_history', {
  id: pgSerial('id').primaryKey(),
  backupPath: pgText('backupPath').notNull(),
  backupType: pgText('backupType').notNull(),
  schemaVersion: pgInteger('schemaVersion'),
  appVersion: pgText('appVersion'),
  totalSize: pgInteger('totalSize'),
  tableCount: pgInteger('tableCount'),
  rowCount: pgInteger('rowCount'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update PostgreSQL CREATE TABLE**

Replace the existing `system_backup_history` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS system_backup_history (
  id SERIAL PRIMARY KEY,
  "backupPath" TEXT NOT NULL,
  "backupType" TEXT NOT NULL,
  "schemaVersion" INTEGER,
  "appVersion" TEXT,
  "totalSize" INTEGER,
  "tableCount" INTEGER,
  "rowCount" INTEGER,
  timestamp BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
```

**Changes:** Renamed `dirname` → `backupPath`, `type` → `backupType`, `size` → `totalSize`, `table_count` → `tableCount`, `meshmonitor_version` → `appVersion`, `schema_version` → `schemaVersion`. Added `rowCount`. Made `schemaVersion`, `appVersion`, `totalSize`, `tableCount`, `rowCount` nullable. Removed UNIQUE constraint on old `dirname` (Drizzle doesn't define it).

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/postgres-create.ts
git commit -m "fix: align system_backup_history CREATE TABLE with Drizzle schema (PostgreSQL)"
```

---

### Task 4: Fix `system_backup_history` table in mysql-create.ts

**Files:**
- Modify: `src/db/schema/mysql-create.ts` (lines ~327-339)

**Current MySQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS system_backup_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dirname VARCHAR(255) NOT NULL UNIQUE,
  timestamp BIGINT NOT NULL,
  type VARCHAR(50) NOT NULL,
  size BIGINT NOT NULL,
  table_count INT NOT NULL,
  meshmonitor_version VARCHAR(32) NOT NULL,
  schema_version INT NOT NULL,
  createdAt BIGINT NOT NULL,
  INDEX idx_system_backup_history_timestamp (timestamp DESC),
  INDEX idx_system_backup_history_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Drizzle schema expects:**
```typescript
export const systemBackupHistoryMysql = mysqlTable('system_backup_history', {
  id: mySerial('id').primaryKey(),
  backupPath: myVarchar('backupPath', { length: 512 }).notNull(),
  backupType: myVarchar('backupType', { length: 32 }).notNull(),
  schemaVersion: myInt('schemaVersion'),
  appVersion: myVarchar('appVersion', { length: 32 }),
  totalSize: myInt('totalSize'),
  tableCount: myInt('tableCount'),
  rowCount: myInt('rowCount'),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update MySQL CREATE TABLE**

Replace the existing `system_backup_history` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS system_backup_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  backupPath VARCHAR(512) NOT NULL,
  backupType VARCHAR(32) NOT NULL,
  schemaVersion INT,
  appVersion VARCHAR(32),
  totalSize INT,
  tableCount INT,
  rowCount INT,
  timestamp BIGINT NOT NULL,
  createdAt BIGINT NOT NULL,
  INDEX idx_system_backup_history_timestamp (timestamp DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Changes:** Same column renames as PostgreSQL. Removed index on old `type` column (now `backupType`). Keep timestamp index.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/mysql-create.ts
git commit -m "fix: align system_backup_history CREATE TABLE with Drizzle schema (MySQL)"
```

---

### Task 5: Fix `user_map_preferences` table in postgres-create.ts

**Files:**
- Modify: `src/db/schema/postgres-create.ts` (lines ~343-350)

**Current PostgreSQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS user_map_preferences (
  "userId" INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  "centerLat" DOUBLE PRECISION,
  "centerLng" DOUBLE PRECISION,
  zoom INTEGER,
  "selectedNodeNum" BIGINT,
  "updatedAt" BIGINT NOT NULL
);
```

**Drizzle schema expects:**
```typescript
export const userMapPreferencesPostgres = pgTable('user_map_preferences', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  centerLat: pgReal('centerLat'),
  centerLng: pgReal('centerLng'),
  zoom: pgReal('zoom'),
  selectedLayer: pgText('selectedLayer'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update PostgreSQL CREATE TABLE**

Replace the existing `user_map_preferences` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS user_map_preferences (
  id SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "centerLat" REAL,
  "centerLng" REAL,
  zoom REAL,
  "selectedLayer" TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
```

**Changes:** Added `id SERIAL PRIMARY KEY`, `userId` is now NOT NULL with FK (not PK), `zoom` changed from INTEGER to REAL, removed `selectedNodeNum`, added `selectedLayer` and `createdAt`.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/postgres-create.ts
git commit -m "fix: align user_map_preferences CREATE TABLE with Drizzle schema (PostgreSQL)"
```

---

### Task 6: Fix `user_map_preferences` table in mysql-create.ts

**Files:**
- Modify: `src/db/schema/mysql-create.ts` (lines ~368-376)

**Current MySQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS user_map_preferences (
  userId INT PRIMARY KEY,
  centerLat DOUBLE,
  centerLng DOUBLE,
  zoom INT,
  selectedNodeNum BIGINT,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Drizzle schema expects:**
```typescript
export const userMapPreferencesMysql = mysqlTable('user_map_preferences', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  centerLat: myDouble('centerLat'),
  centerLng: myDouble('centerLng'),
  zoom: myDouble('zoom'),
  selectedLayer: myVarchar('selectedLayer', { length: 64 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update MySQL CREATE TABLE**

Replace the existing `user_map_preferences` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS user_map_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NOT NULL,
  centerLat DOUBLE,
  centerLng DOUBLE,
  zoom DOUBLE,
  selectedLayer VARCHAR(64),
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Changes:** Added `id AUTO_INCREMENT PRIMARY KEY`, `userId` is NOT NULL (not PK), `zoom` changed from INT to DOUBLE, removed `selectedNodeNum`, added `selectedLayer` and `createdAt`.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/mysql-create.ts
git commit -m "fix: align user_map_preferences CREATE TABLE with Drizzle schema (MySQL)"
```

---

### Task 7: Fix `custom_themes` table in postgres-create.ts

**Files:**
- Modify: `src/db/schema/postgres-create.ts` (lines ~334-341)

**Current PostgreSQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS custom_themes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  "createdBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
```

**Drizzle schema expects:**
```typescript
export const customThemesPostgres = pgTable('custom_themes', {
  id: pgSerial('id').primaryKey(),
  name: pgText('name').notNull(),
  slug: pgText('slug').notNull().unique(),
  definition: pgText('definition').notNull(),
  is_builtin: pgBoolean('is_builtin').default(false),
  created_by: pgInteger('created_by').references(() => usersPostgres.id, { onDelete: 'set null' }),
  created_at: pgBigint('created_at', { mode: 'number' }).notNull(),
  updated_at: pgBigint('updated_at', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update PostgreSQL CREATE TABLE**

Replace the existing `custom_themes` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS custom_themes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

**Changes:** Added `slug TEXT NOT NULL UNIQUE` and `is_builtin BOOLEAN DEFAULT false`. Changed column naming from camelCase (`createdBy`, `createdAt`, `updatedAt`) to snake_case (`created_by`, `created_at`, `updated_at`) to match Drizzle. Removed UNIQUE from `name` (Drizzle doesn't define it; uniqueness is on `slug`).

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/postgres-create.ts
git commit -m "fix: align custom_themes CREATE TABLE with Drizzle schema (PostgreSQL)"
```

---

### Task 8: Fix `custom_themes` table in mysql-create.ts

**Files:**
- Modify: `src/db/schema/mysql-create.ts` (lines ~358-366)

**Current MySQL CREATE:**
```sql
CREATE TABLE IF NOT EXISTS custom_themes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  createdBy INT,
  createdAt BIGINT NOT NULL,
  updatedAt BIGINT NOT NULL,
  FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Drizzle schema expects:**
```typescript
export const customThemesMysql = mysqlTable('custom_themes', {
  id: mySerial('id').primaryKey(),
  name: myVarchar('name', { length: 128 }).notNull(),
  slug: myVarchar('slug', { length: 128 }).notNull().unique(),
  definition: myText('definition').notNull(),
  is_builtin: myBoolean('is_builtin').default(false),
  created_by: myInt('created_by').references(() => usersMysql.id, { onDelete: 'set null' }),
  created_at: myBigint('created_at', { mode: 'number' }).notNull(),
  updated_at: myBigint('updated_at', { mode: 'number' }).notNull(),
});
```

- [ ] **Step 1: Update MySQL CREATE TABLE**

Replace the existing `custom_themes` CREATE TABLE with:

```sql
CREATE TABLE IF NOT EXISTS custom_themes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(128) NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  created_by INT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Changes:** Added `slug VARCHAR(128) NOT NULL UNIQUE` and `is_builtin BOOLEAN DEFAULT false`. Changed `name` from `VARCHAR(255)` to `VARCHAR(128)`. Changed column naming from camelCase to snake_case. Removed UNIQUE from `name`. Updated FK column name to `created_by`.

- [ ] **Step 2: Commit**

```bash
git add src/db/schema/mysql-create.ts
git commit -m "fix: align custom_themes CREATE TABLE with Drizzle schema (MySQL)"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass (schema files are only used during fresh installs, not in tests)

- [ ] **Step 2: Cross-reference each table**

For each of the 4 tables, visually verify that the CREATE TABLE columns now match the Drizzle schema column names, types, and constraints:

1. `read_messages` — id, userId, messageId, readAt
2. `system_backup_history` — id, backupPath, backupType, schemaVersion, appVersion, totalSize, tableCount, rowCount, timestamp, createdAt
3. `user_map_preferences` — id, userId, centerLat, centerLng, zoom, selectedLayer, createdAt, updatedAt
4. `custom_themes` — id, name, slug, definition, is_builtin, created_by, created_at, updated_at

- [ ] **Step 3: Commit any final cleanup**

If any adjustments were needed, commit them.
