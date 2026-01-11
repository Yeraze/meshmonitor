# Database Migration Guide

This guide explains how to migrate your MeshMonitor data from SQLite (v2.x) to PostgreSQL or MySQL (v3.x).

## Overview

MeshMonitor 3.x supports three database backends:
- **SQLite** (default) - Great for small to medium deployments
- **PostgreSQL** - Recommended for larger deployments or high availability
- **MySQL/MariaDB** - Alternative for environments already running MySQL

## Prerequisites

- MeshMonitor 3.x Docker image (v3.0.0-beta5 or later)
- Access to your existing SQLite database file
- PostgreSQL or MySQL server (can be a Docker container)

## Migration Steps

### Step 1: Stop and Backup Your v2.x Instance

```bash
# Stop the existing MeshMonitor container
docker compose down

# Backup your SQLite database
cp /path/to/meshmonitor-data/meshmonitor.db /path/to/backup/meshmonitor.db.backup

# Also backup your entire data directory
cp -r /path/to/meshmonitor-data /path/to/backup/meshmonitor-data-backup
```

### Step 2: Start PostgreSQL (or MySQL)

#### Option A: PostgreSQL with Docker Compose

Add PostgreSQL to your `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: meshmonitor-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: meshmonitor
      POSTGRES_USER: meshmonitor
      POSTGRES_PASSWORD: your_secure_password
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor -d meshmonitor"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres-data:
```

Start PostgreSQL:
```bash
docker compose up -d postgres
```

#### Option B: MySQL with Docker Compose

Add MySQL to your `docker-compose.yml`:

```yaml
services:
  mysql:
    image: mysql:8
    container_name: meshmonitor-mysql
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: meshmonitor
      MYSQL_USER: meshmonitor
      MYSQL_PASSWORD: your_secure_password
      MYSQL_ROOT_PASSWORD: your_root_password
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  mysql-data:
```

Start MySQL:
```bash
docker compose up -d mysql
```

### Step 3: Initialize the New Database

Start MeshMonitor temporarily to create the database schema:

```yaml
# Add to your docker-compose.yml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:3.0.0-beta5
    container_name: meshmonitor
    environment:
      # For PostgreSQL:
      DATABASE_URL: postgres://meshmonitor:your_secure_password@postgres:5432/meshmonitor
      # For MySQL:
      # DATABASE_URL: mysql://meshmonitor:your_secure_password@mysql:3306/meshmonitor
    depends_on:
      postgres:
        condition: service_healthy
    # ... rest of your config
```

```bash
# Start MeshMonitor to initialize the schema
docker compose up -d meshmonitor

# Wait for initialization (check logs)
docker compose logs -f meshmonitor

# Look for: "[PostgreSQL] Schema created successfully"
# Then stop the container
docker compose stop meshmonitor
```

### Step 4: Run the Migration

Copy your SQLite database into the container and run the migration:

```bash
# Copy SQLite database to container
docker cp /path/to/backup/meshmonitor.db meshmonitor:/tmp/meshmonitor.db

# Run the migration (PostgreSQL)
docker exec meshmonitor node /app/dist/cli/migrate-db.js \
  --from "sqlite:/tmp/meshmonitor.db" \
  --to "postgres://meshmonitor:your_secure_password@postgres:5432/meshmonitor" \
  --verbose

# Or for MySQL:
docker exec meshmonitor node /app/dist/cli/migrate-db.js \
  --from "sqlite:/tmp/meshmonitor.db" \
  --to "mysql://meshmonitor:your_secure_password@mysql:3306/meshmonitor" \
  --verbose
```

You should see output like:
```
🚀 MeshMonitor Database Migration Tool

📂 Connecting to SQLite: /tmp/meshmonitor.db
🐘 Connecting to PostgreSQL: postgres://meshmonitor:****@postgres:5432/meshmonitor
✅ Connected to both databases

📋 Creating PostgreSQL schema from application definitions...
  ✅ Created table: nodes
  ✅ Created table: messages
  ...
✅ PostgreSQL schema created

📊 Migration Progress:
  📦 nodes: 150 rows... ✅ 150 migrated
  📦 messages: 1200 rows... ✅ 1200 migrated
  ...

✅ Migration complete!
```

### Step 5: Start MeshMonitor

```bash
# Start MeshMonitor with the new database
docker compose up -d meshmonitor

# Verify it's working
docker compose logs -f meshmonitor
```

### Step 6: Verify the Migration

1. Open MeshMonitor in your browser
2. Check that your nodes appear on the map
3. Verify your message history is intact
4. Confirm your user accounts work

## Troubleshooting

### "column X does not exist" errors

This can happen if the migration script couldn't map all columns. The script handles known column name differences (like `password_hash` → `passwordHash`), but if you see this error:

1. Check the MeshMonitor logs for specific column issues
2. The affected data may need manual migration
3. Open an issue on GitHub with the error details

### Connection refused errors

Make sure:
- The database container is running and healthy
- The connection string uses the correct hostname (container name for Docker networking)
- The credentials are correct
- The database exists

### Migration warnings

Some warnings are expected:
- `⏭️ table: 0 rows (skipped)` - Empty tables are skipped
- Foreign key constraint warnings may appear if migrating in wrong order (usually safe to ignore)

## Docker Compose Example (Complete)

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: meshmonitor-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: meshmonitor
      POSTGRES_USER: meshmonitor
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-changeme}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor -d meshmonitor"]
      interval: 10s
      timeout: 5s
      retries: 5

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    restart: unless-stopped
    ports:
      - "3000:3001"
    environment:
      DATABASE_URL: postgres://meshmonitor:${POSTGRES_PASSWORD:-changeme}@postgres:5432/meshmonitor
      MESHTASTIC_NODE_HOST: ${MESHTASTIC_NODE_HOST}
      MESHTASTIC_NODE_PORT: ${MESHTASTIC_NODE_PORT:-4403}
      BASE_URL: ${BASE_URL:-/}
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - meshmonitor-data:/data

volumes:
  postgres-data:
  meshmonitor-data:
```

## Reverting to SQLite

If you need to revert:

1. Stop MeshMonitor
2. Remove `DATABASE_URL` from your environment
3. Restore your SQLite backup to the data volume
4. Restart MeshMonitor

```bash
docker compose stop meshmonitor
# Remove DATABASE_URL from docker-compose.yml or .env
docker cp /path/to/backup/meshmonitor.db meshmonitor:/data/meshmonitor.db
docker compose up -d meshmonitor
```
