# Database

MeshMonitor supports two database backends:

- **SQLite** (default) - Simple file-based database, no additional setup required
- **PostgreSQL** - Scalable relational database for larger deployments

## Choosing a Database

### SQLite (Recommended for Most Users)

SQLite is the default and recommended choice for most deployments:

- **Zero configuration** - Works out of the box
- **Single file** - Easy to backup and migrate
- **Low resource usage** - Ideal for home servers and Raspberry Pi
- **Sufficient for most deployments** - Handles thousands of nodes without issue

SQLite is automatically used when no `DATABASE_URL` environment variable is set.

### PostgreSQL (For Advanced Deployments)

Consider PostgreSQL when:

- You have **1000+ active nodes** with high message volume
- You need **concurrent access** from multiple services
- You require **advanced queries** or reporting
- You want **enterprise-grade reliability** and backups
- You're running **multiple MeshMonitor instances** accessing the same data

## Configuration

### SQLite Configuration

SQLite requires no configuration. The database file is stored at:

```
/data/meshmonitor.db
```

You can customize the path with the `DATABASE_PATH` environment variable:

```yaml
environment:
  - DATABASE_PATH=/data/meshmonitor.db
```

### PostgreSQL Configuration

To use PostgreSQL, set the `DATABASE_URL` environment variable:

```yaml
environment:
  - DATABASE_URL=postgres://user:password@hostname:5432/meshmonitor
```

#### Connection String Format

```
postgres://[user]:[password]@[host]:[port]/[database]
```

| Component | Description | Example |
|-----------|-------------|---------|
| `user` | PostgreSQL username | `meshmonitor` |
| `password` | PostgreSQL password | `secretpassword` |
| `host` | Server hostname or IP | `localhost`, `postgres`, `db.example.com` |
| `port` | PostgreSQL port | `5432` (default) |
| `database` | Database name | `meshmonitor` |

#### Docker Compose with PostgreSQL

Use the [Docker Compose Configurator](/configurator) to generate a complete configuration, or use this example:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: meshmonitor-postgres
    restart: unless-stopped
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=meshmonitor
      - POSTGRES_USER=meshmonitor
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor -d meshmonitor"]
      interval: 10s
      timeout: 5s
      retries: 5

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    restart: unless-stopped
    volumes:
      - meshmonitor-data:/data
    env_file: .env
    environment:
      - DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/meshmonitor
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  meshmonitor-data:
    driver: local
  postgres-data:
    driver: local
```

Create a `.env` file:

```bash
# PostgreSQL credentials
POSTGRES_USER=meshmonitor
POSTGRES_PASSWORD=your_secure_password_here
```

## Migrating from SQLite to PostgreSQL

If you have an existing SQLite installation and want to migrate to PostgreSQL, MeshMonitor includes a migration tool.

### Prerequisites

1. A running PostgreSQL server (local or remote)
2. An empty PostgreSQL database created for MeshMonitor
3. Access to your existing SQLite database file

### Migration Steps

#### 1. Stop MeshMonitor

```bash
docker compose stop meshmonitor
```

#### 2. Create the PostgreSQL Database

If using the included PostgreSQL container:

```bash
docker compose up -d postgres
```

If using an external PostgreSQL server:

```sql
CREATE DATABASE meshmonitor;
CREATE USER meshmonitor WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE meshmonitor TO meshmonitor;
```

#### 3. Copy the SQLite Database

Extract the SQLite database from the Docker volume:

```bash
docker cp meshmonitor:/data/meshmonitor.db ./meshmonitor.db
```

#### 4. Run the Migration

Using the MeshMonitor CLI migration tool:

```bash
# From the MeshMonitor source directory
npx tsx src/cli/migrate-db.ts \
  --from sqlite:./meshmonitor.db \
  --to postgres://meshmonitor:password@localhost:5432/meshmonitor
```

Or with Docker:

```bash
docker run --rm -it \
  -v $(pwd)/meshmonitor.db:/data/meshmonitor.db:ro \
  --network host \
  ghcr.io/yeraze/meshmonitor:latest \
  npm run migrate-db -- \
    --from sqlite:/data/meshmonitor.db \
    --to postgres://meshmonitor:password@localhost:5432/meshmonitor
```

#### Migration Options

| Option | Description |
|--------|-------------|
| `--from` | Source database URL (e.g., `sqlite:./meshmonitor.db`) |
| `--to` | Target database URL (e.g., `postgres://user:pass@host/db`) |
| `--dry-run` | Show what would be migrated without making changes |
| `--verbose` | Enable detailed logging |

#### 5. Verify the Migration

Check that data was migrated correctly:

```bash
# Connect to PostgreSQL
docker compose exec postgres psql -U meshmonitor -d meshmonitor

# Check row counts
SELECT 'nodes' as table_name, COUNT(*) as count FROM nodes
UNION ALL SELECT 'messages', COUNT(*) FROM messages
UNION ALL SELECT 'telemetry', COUNT(*) FROM telemetry;
```

#### 6. Update Configuration

Update your `docker-compose.yml` to use PostgreSQL:

```yaml
environment:
  - DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/meshmonitor
```

#### 7. Start MeshMonitor

```bash
docker compose up -d meshmonitor
```

#### 8. Verify Operation

Check the logs to confirm PostgreSQL is being used:

```bash
docker compose logs meshmonitor | grep -i "database\|postgres"
```

You should see:
```
[INFO] Database: PostgreSQL (configured via DATABASE_URL)
[INFO] [DatabaseService] Using PostgreSQL driver for Drizzle repositories
[INFO] [PostgreSQL Driver] Database initialized successfully
```

### Migration Notes

- **Data integrity**: The migration tool validates data during transfer
- **Large databases**: Migration of 100,000+ rows may take several minutes
- **Rollback**: Keep your SQLite database as a backup until you've verified the migration
- **Downtime**: Plan for brief downtime during migration

### Troubleshooting Migration

#### Connection refused

Ensure PostgreSQL is running and accessible:

```bash
docker compose exec postgres pg_isready -U meshmonitor
```

#### Permission denied

Verify database user has proper permissions:

```sql
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO meshmonitor;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO meshmonitor;
```

#### Type conversion errors

Some SQLite data types are loosely typed. The migration tool handles most cases, but you may see warnings for:

- Float values in integer columns (automatically truncated)
- Boolean values stored as 0/1 (automatically converted)

## Database Schema

MeshMonitor uses [Drizzle ORM](https://orm.drizzle.team/) for type-safe database operations. The schema supports both SQLite and PostgreSQL with automatic dialect handling.

### Core Tables

| Table | Description |
|-------|-------------|
| `nodes` | Meshtastic node information |
| `messages` | Chat messages and packets |
| `channels` | Channel configuration |
| `telemetry` | Device telemetry data |
| `settings` | Application settings |
| `traceroutes` | Route tracing results |
| `neighbor_info` | Neighbor node information |

### Authentication Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts |
| `sessions` | Active sessions |
| `permissions` | User permissions |
| `api_tokens` | API authentication tokens |
| `audit_log` | Security audit trail |

### Additional Tables

| Table | Description |
|-------|-------------|
| `push_subscriptions` | Web push notification subscriptions |
| `user_notification_preferences` | Per-user notification settings |
| `backup_history` | Backup operation history |
| `custom_themes` | User-created themes |

For the complete schema definition, see [`src/db/schema/`](https://github.com/yeraze/meshmonitor/tree/main/src/db/schema).

## Database Maintenance

### SQLite

SQLite maintenance is largely automatic. MeshMonitor enables:

- **WAL mode** - Better concurrency and crash recovery
- **Automatic checkpointing** - Keeps the WAL file size manageable

Manual vacuum (optional, for reclaiming disk space):

```bash
docker compose exec meshmonitor sqlite3 /data/meshmonitor.db "VACUUM;"
```

### PostgreSQL

PostgreSQL has built-in maintenance, but consider:

```sql
-- Reclaim disk space
VACUUM ANALYZE;

-- Check database size
SELECT pg_size_pretty(pg_database_size('meshmonitor'));

-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

## Backups

### SQLite Backup

```bash
# Stop MeshMonitor for consistent backup
docker compose stop meshmonitor

# Copy database file
docker cp meshmonitor:/data/meshmonitor.db ./backup-$(date +%Y%m%d).db

# Restart MeshMonitor
docker compose start meshmonitor
```

Or use the built-in [System Backup](/features/system-backup) feature.

### PostgreSQL Backup

```bash
# Using pg_dump
docker compose exec postgres pg_dump -U meshmonitor meshmonitor > backup-$(date +%Y%m%d).sql

# Compressed backup
docker compose exec postgres pg_dump -U meshmonitor meshmonitor | gzip > backup-$(date +%Y%m%d).sql.gz
```

### Restore PostgreSQL

```bash
# Drop and recreate database
docker compose exec postgres psql -U meshmonitor -c "DROP DATABASE meshmonitor; CREATE DATABASE meshmonitor;"

# Restore from backup
cat backup.sql | docker compose exec -T postgres psql -U meshmonitor meshmonitor
```

## Performance Tuning

### SQLite

SQLite generally performs well with default settings. For high-traffic deployments:

```sql
-- Increase cache size (default 2000 pages)
PRAGMA cache_size = 10000;

-- Set synchronous mode (trade durability for speed)
PRAGMA synchronous = NORMAL;
```

### PostgreSQL

For production PostgreSQL deployments:

```sql
-- Increase shared buffers (25% of RAM)
ALTER SYSTEM SET shared_buffers = '1GB';

-- Increase work memory for complex queries
ALTER SYSTEM SET work_mem = '64MB';

-- Enable parallel queries
ALTER SYSTEM SET max_parallel_workers_per_gather = 2;
```

## Need Help?

- Check [Frequently Asked Questions](/faq)
- Review [Deployment Guide](/deployment/DEPLOYMENT_GUIDE)
- Visit [GitHub Issues](https://github.com/yeraze/meshmonitor/issues)
