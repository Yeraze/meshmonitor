# Release Monitor & Auto-Diagnose

Monitor a release's pipeline workflows (release.yml, docker-publish.yml, desktop-release.yml), diagnose failures, and either auto-rerun on infrastructure flakes or surface root-cause analysis.

## Usage

Invoke with: `/release-monitor [TAG]`

Tag is optional (used for log lines and notifications). Filtering is by `--event release` so the script picks up whichever release was most recently published.

## Instructions

### Phase 1: Wait for release workflows (delegated to script — saves tokens)

**Do not poll the GitHub API yourself.** Run `scripts/watch-release.sh` and read its exit code:

```bash
bash scripts/watch-release.sh -q [TAG]
echo "EXIT=$?"
```

The script polls every 60s, blocks until every release-event workflow is decided, and emits exactly **one** terminal line plus an exit code:

| Exit | Meaning | What you do |
| ---- | ------- | ----------- |
| `0`  | All release workflows ended in `success` or `skipped` | Report success and stop |
| `1`  | At least one release workflow ended in `failure` / `cancelled` / `timed_out` | Proceed to Phase 2 |
| `2`  | Usage / GitHub API error | Stop, report the error to the user |

The `-q` flag suppresses per-cycle status; you only see the final pass/fail line. Drop the `-q` flag if you want to debug the polling loop itself.

Release workflows can take 30+ minutes (Docker multi-arch builds, Tauri Windows/macOS/Linux builds), so always pass an explicit Bash timeout — `3600000` ms (1 hour) is a safe default — or use `run_in_background` and check the task on completion.

### Phase 2: Diagnose

Only reached when `watch-release.sh` returned exit code `1`.

1. Identify the failing workflow run(s):
   ```bash
   gh run list --limit 10 --event release \
     --json databaseId,name,conclusion \
     -q '.[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out") | "\(.databaseId) \(.name)"'
   ```
2. Fetch the failing logs:
   ```bash
   gh run view <run_id> --log-failed
   ```
3. Categorize the failure:
   - **Infrastructure / network / runner-loss / timeout** — flaky CI, not the code.
     Examples: "The runner has received a shutdown signal", "Error: connect ETIMEDOUT", "EOF on push of layer", any 5xx from ghcr.io/dockerhub.
     **Action:** auto-retry with `gh run rerun <run_id>` and return to Phase 1.
   - **Image not found for platform / linux/arm64 not available** — Dockerfile base image regression.
     **Action:** prepare a fix on a branch (do not auto-rerun), prompt user.
   - **Test failure / build failure** — real regression.
     **Action:** diagnose root cause from the log, prepare a fix, prompt user before pushing.
   - **Auth / permission denied / 401 from ghcr.io** — token / secret issue, cannot auto-fix.
     **Action:** stop and report to user with the exact log line.

### Phase 3: Auto-retry (only for transient infra failures)

```bash
gh run rerun <run_id>
sleep 30                                  # let GitHub spawn the new run
bash scripts/watch-release.sh -q [TAG]    # back to Phase 1
echo "EXIT=$?"
```

**Maximum 2 retries per workflow.** If a workflow fails twice, treat it as a real failure and stop.

### Phase 4: Reporting

```
## Release Monitor Report for TAG

**Release:** <tag or "latest">
**Result:** ✓ ALL GREEN / ✗ FAILED — <workflow name> (<conclusion>)

### Workflows
- ✓ Release Pipeline
- ✓ Docker Build and Publish
- ✗ Desktop Release — failure (rerun #1 also failed)

### Failure analysis
<log excerpt + categorization + recommended next step>
```

## Important Rules

- **Never push tags or recreate releases manually.** GitHub creates the tag when you publish a release; the project policy says let it.
- **Auto-rerun only for infrastructure flakes** — don't blindly retry test/build failures.
- **Cap retries at 2 per workflow.** Three failures = real problem, escalate.
- **Don't poll `gh run list` in a loop yourself.** Delegate the wait to `scripts/watch-release.sh -q [TAG]` and dispatch on its exit code. That's the whole point of the script — it keeps polling output out of the model's context.
- **Pair with `/ci-monitor` semantics.** This skill is the release-pipeline counterpart; `/ci-monitor` watches per-PR CI runs.
