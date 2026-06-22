---
name: deploy
description: Build and deploy the MeshMonitor dev container from local code, then verify the right code is running. Use for "build and deploy for testing", "rebuild and redeploy", "tear it down".
---

Build, deploy, and verify the MeshMonitor dev container from the **local working tree** so the user can test the current code.

## Arguments
$ARGUMENTS

- Empty / "deploy" / "redeploy" → build + `up -d` (preserves data).
- "fresh" / "clean" / "no-cache" / "from scratch" → `build --no-cache` + `up -d` (rebuilds the **image**, never the volume).
- "tear down" / "stop" / "down" → `docker compose ... down` (NO `-v`).
- A profile name (`sqlite`, `postgres`, `mysql`) overrides the default `sqlite`.

## ⛔ Data-loss guardrails (read first — non-negotiable)

A prior run destroyed the user's `meshmonitor_*` data volume (2026-04-18, unrecoverable). Before running ANY docker command, check it against this list:

- **NEVER** use `-v` / `--volumes` on `docker compose down` or `docker compose rm`. Not for "cleanup", not ever, unless the user explicitly types "wipe the volume" in this turn.
- **NEVER** rename the compose project/file as part of a deploy (different project name = orphaned volumes).
- "Deploy" / "redeploy" = `build` + `up -d`. "Fresh" / "clean" = `build --no-cache` + `up -d`. None of these touch volumes.
- Before and after `up -d`, run `docker volume ls | grep meshmonitor`. If the data volume's creation timestamp changed, you destroyed data — STOP and report immediately.

When in doubt about a destructive command, delegate the whole job to the **`docker-dev-deployer`** agent, which carries the full guardrail checklist.

## Steps

### 1. Pre-flight
- Confirm no local `npm run dev` is running — it fights the container for ports. (`docker ps` / check.)
- **If you are in a git worktree:** `docker-compose.dev.local.yml` is **gitignored** and won't exist. Copy it from the main checkout first, or the container gets no USB devices:
  ```bash
  [ -f docker-compose.dev.local.yml ] || cp ../meshmonitor/docker-compose.dev.local.yml .
  ```
- Note the deployed commit so you can verify later: `git rev-parse --short HEAD`.

### 2. Build + deploy
The USB override (`docker-compose.dev.local.yml`) maps `/dev/ttyUSB0-3` and adds the `dialout` group — **required** for serial nodes, and it only patches the `meshmonitor-sqlite` service. Always include both `-f` files:

```bash
# redeploy (default)
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml build
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml up -d

# fresh image (only when asked)
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml build --no-cache && \
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml up -d

# tear down (NO -v, ever)
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml down
```

Use `docker compose` (space), never the legacy `docker-compose`. Pass the profile via `COMPOSE_PROFILES=`, not `--profile`.

### 3. Verify the *right* code deployed
A successful `up -d` does NOT mean your code is in the image — a cached layer can ship stale code.

```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml ps
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml logs --tail=40 meshmonitor-sqlite
```

- Container is `Up`/healthy.
- Confirm a string unique to this change is present in the served bundle, or that startup logs show the expected migration/version. Don't just assert "it's running".

### 4. Access details (for the user / for testing)
- App: **http://localhost:8081/meshmonitor** (the sqlite app publishes `8081:3001`; `BASE_URL=/meshmonitor`). *(CLAUDE.md mentions :8080 — that's a host proxy, not the container port; the container itself is 8081.)*
- Tileserver: http://localhost:8082
- Login: `admin` / `changeme` (the seeded default — **not** `changeme1`, which is only the `api-test.sh` default). Login is rate-limited; if you lock yourself out, wait it out — the container has **no `sqlite3` CLI** to reset it.
- Send test messages on the `gauntlet` channel, never Primary.

### 5. Report
- What was built (redeploy vs no-cache), the deployed short SHA, container status, the verification you used to confirm *this* code is live, and the access URL.
- Do **not** push, open PRs, or run the test suite — this skill is build/deploy/verify only.
