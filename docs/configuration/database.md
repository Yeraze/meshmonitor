# Choosing a Database: SQLite, PostgreSQL, MySQL

MeshMonitor can store its data in SQLite, PostgreSQL, or MySQL. SQLite is the default and needs no setup. One setting, `DATABASE_URL`, picks the backend.

## Which one should I use?

**Stay on SQLite** unless you have a reason to move. It is a single file in the `/data` volume, needs no extra container, and handles a typical home or club install well, including on a Raspberry Pi.

**Pick PostgreSQL or MySQL** when:

- You already run one of them and want MeshMonitor's data there, with your existing backups and monitoring.
- You want to run the database on a separate host or managed service.
- Your install is large (many sources, long retention) and you want a server database you can tune.

| Backend | How to select it | Tested in CI |
|---------|------------------|--------------|
| SQLite | Leave `DATABASE_URL` unset | Yes |
| PostgreSQL | `DATABASE_URL=postgres://...` or `postgresql://...` | PostgreSQL 16 |
| MySQL | `DATABASE_URL=mysql://...` | MySQL 8 |
| MariaDB | `DATABASE_URL=mariadb://...` | No (uses the MySQL driver) |

::: warning Switching starts with an empty database
Setting `DATABASE_URL` on an existing install does not move your data. MeshMonitor connects to the new database, builds its tables, and creates a fresh `admin` account (password `changeme`, or `ADMIN_PASSWORD` if set). Your SQLite file stays untouched in `/data`. To bring your data along, see [Move existing data](#move-existing-data).
:::

## Settings

| Variable | What it does | Default |
|----------|--------------|---------|
| `DATABASE_URL` | Connection string for PostgreSQL or MySQL. Unset means SQLite. | unset |
| `DATABASE_PATH` | SQLite file location. Ignored when `DATABASE_URL` is set. | `/data/meshmonitor.db` |
| `DATABASE_POOL_SIZE` | Most connections MeshMonitor opens to PostgreSQL or MySQL. | `20` |

Keep the `/data` volume even on PostgreSQL or MySQL. MeshMonitor still writes backups and logs there.

If a password holds characters such as `@`, `:`, `/` or `#`, percent-encode them in the URL (`@` becomes `%40`).

## SQLite

Nothing to set up. The default compose file already mounts `/data`:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data

volumes:
  meshmonitor-data:
```

To keep the file somewhere else in the container, set `DATABASE_PATH`.

## PostgreSQL

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      - POSTGRES_DB=meshmonitor
      - POSTGRES_USER=meshmonitor
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor -d meshmonitor"]
      interval: 10s
      timeout: 5s
      retries: 5

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    restart: unless-stopped
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - DATABASE_URL=postgres://meshmonitor:${POSTGRES_PASSWORD}@postgres:5432/meshmonitor
      - SESSION_SECRET=${SESSION_SECRET}
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  meshmonitor-data:
  postgres-data:
```

Put the secrets in a `.env` file next to the compose file:

```bash
POSTGRES_PASSWORD=pick-a-long-random-password
SESSION_SECRET=output-of-openssl-rand-hex-32
```

Use the service name (`postgres`) as the host, not `localhost`: inside the MeshMonitor container, `localhost` is MeshMonitor itself.

**TLS to a remote server:** add `sslmode` to the URL.

- `?sslmode=verify-full` encrypts and checks the server certificate.
- `?sslmode=no-verify` encrypts but skips the check (for self-signed certificates).

## MySQL

```yaml
services:
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      - MYSQL_DATABASE=meshmonitor
      - MYSQL_USER=meshmonitor
      - MYSQL_PASSWORD=${MYSQL_PASSWORD}
      - MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 10s
      timeout: 5s
      retries: 10

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    restart: unless-stopped
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - DATABASE_URL=mysql://meshmonitor:${MYSQL_PASSWORD}@mysql:3306/meshmonitor
      - SESSION_SECRET=${SESSION_SECRET}
    depends_on:
      mysql:
        condition: service_healthy

volumes:
  meshmonitor-data:
  mysql-data:
```

The health check pings `127.0.0.1` on purpose. On first start MySQL runs a setup server with networking off, so a TCP ping only passes once the real server is up.

MeshMonitor reads only host, port, user, password and database name from a MySQL URL. Anything after `?` is ignored, so it cannot connect over TLS. If your MySQL server requires TLS, use PostgreSQL or a local MySQL instead.

## Move existing data

MeshMonitor ships a one-way tool that copies a SQLite database into PostgreSQL or MySQL. It does not go the other way, and it does not copy between PostgreSQL and MySQL.

These steps assume the PostgreSQL compose file above; for MySQL, swap the service name and URL.

::: tip Migrate before you upgrade
Run the copy with the same MeshMonitor version that wrote your SQLite database. A newer tool may expect tables or columns your database does not have yet. The steps below use your current `meshmonitor` image, so do not pull a new one until the switch is done; startup migrations bring the new database up to date when you upgrade later.
:::

1. **Back up first.** Make a [System Backup](/features/system-backup) or copy `meshmonitor.db` out of the volume.
2. **Add the database service** to your compose file, but do **not** set `DATABASE_URL` yet. MeshMonitor must not start against the new database before the copy, or it creates its own rows first.
3. **Stop MeshMonitor and start the database:**
   ```bash
   docker compose stop meshmonitor
   docker compose up -d postgres
   ```
4. **Preview the copy** (writes nothing):
   ```bash
   docker compose run --rm meshmonitor npm run migrate-db -- \
     --from sqlite:/data/meshmonitor.db \
     --to postgres://meshmonitor:YOUR_PASSWORD@postgres:5432/meshmonitor \
     --dry-run
   ```
5. **Run it for real:** repeat the command without `--dry-run`. The tool builds the tables, copies each one, and prints a row count per table.
6. **Switch over:** add `DATABASE_URL` to the `meshmonitor` service and run `docker compose up -d`. Keep the same `SESSION_SECRET`.
7. **Check:** `docker compose logs meshmonitor | grep -i database` should show `Database: PostgreSQL`, and you should log in with your old account.

The tool skips a few tables of logs and per-user state: the packet log, backup history, auto-traceroute and auto key-repair logs and state, the Auto-Pathfinding target list, and saved map preferences. Everything else, including users, sources, nodes, messages and telemetry, comes across.

Your SQLite file stays in `/data`. To go back, remove `DATABASE_URL` and restart; anything recorded while on PostgreSQL or MySQL stays there.

::: warning System Backup is not a migration tool
A System Backup restores into whichever database MeshMonitor is running on. Restore is tested only into the same kind of database the backup came from. Some column names differ between SQLite and PostgreSQL/MySQL, so a SQLite backup restored into PostgreSQL or MySQL can lose data. Use `migrate-db` to switch.
:::

## Backups

[System Backup](/features/system-backup) works on all three backends. It exports every table to JSON under `/data/system-backups` and can run on a schedule. That is the simplest choice for any backend.

You can also use the database's own tools:

- **SQLite:** stop MeshMonitor, then copy `meshmonitor.db` out of the `/data` volume.
- **PostgreSQL:**
  ```bash
  docker compose exec -T postgres pg_dump -U meshmonitor meshmonitor > meshmonitor.sql
  ```
- **MySQL:**
  ```bash
  docker compose exec -T mysql sh -c 'mysqldump --no-tablespaces -u meshmonitor -p"$MYSQL_PASSWORD" meshmonitor' > meshmonitor.sql
  ```

## Troubleshooting

**`DATABASE_URL provided but not recognized as PostgreSQL or MySQL. Using SQLite.`**
The URL must start with `postgres://`, `postgresql://`, `mysql://` or `mariadb://`. Until you fix it, MeshMonitor runs on SQLite.

**`PostgreSQL connection failed: ...` or `MySQL connection failed: ...`**
MeshMonitor could not reach the database at startup. The text after the colon says why:

- `ECONNREFUSED` or `getaddrinfo ENOTFOUND`: wrong host or port, or the database is not up yet. Use the compose service name as the host and keep the `depends_on` health check.
- `password authentication failed` (PostgreSQL) or `Access denied` (MySQL): the user or password in the URL does not match. Check for characters that need percent-encoding.
- `self-signed certificate` (PostgreSQL): add `?sslmode=no-verify`, or give the server a trusted certificate and use `?sslmode=verify-full`.

**`Invalid MySQL connection string`**
MeshMonitor could not parse the MySQL URL. Check its shape (`mysql://user:password@host:3306/database`) and percent-encode special characters in the password.

**`Pool saturated: ... Consider raising DATABASE_POOL_SIZE.`**
Requests waited for a free PostgreSQL connection. Raise `DATABASE_POOL_SIZE` (default 20), and make sure the server's `max_connections` allows it.

**After switching, the app is empty and only the `admin` account exists.**
MeshMonitor is on a fresh database. Your data is still in the SQLite file; follow [Move existing data](#move-existing-data).

For schema details and tuning tips, see the developer [Database](/development/database) page.
