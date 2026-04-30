# CI Monitor & Auto-Fix

Monitor a PR's CI pipeline, auto-diagnose failures, apply targeted fixes, and re-push until green.

## Usage

Invoke with: `/ci-monitor <PR_NUMBER>`

## Instructions

### Phase 1: Wait for CI (delegated to script — saves tokens)

**Do not poll the GitHub API yourself.** Run `scripts/watch-ci.sh` and read its exit code:

```bash
bash scripts/watch-ci.sh -q <PR_NUMBER>
echo "EXIT=$?"
```

The script polls every 60s, blocks until the picture is decided, and emits exactly **one** terminal line plus an exit code:

| Exit | Meaning | What you do |
| ---- | ------- | ----------- |
| `0`  | All workflows ended in `success` or `skipped` | Report success and stop |
| `1`  | At least one workflow ended in `failure` / `cancelled` / `timed_out` | Proceed to Phase 2 |
| `2`  | Usage / GitHub API error (bad PR number, gh auth failure) | Stop, report the error to the user |

The `-q` flag suppresses per-cycle status; you only see the final pass/fail line, which keeps the polling out of your context window. Drop the `-q` flag if you want to debug.

Before running, make sure you're on the PR's branch:

```bash
gh pr view <PR_NUMBER> --json headRefName -q .headRefName     # confirm branch
git checkout <branch> && git pull origin <branch>             # if not already there
```

The Bash tool's default 2-minute timeout is too short for full CI runs — pass an explicit timeout (e.g. `1800000` ms = 30 min) when invoking `watch-ci.sh`. If the run is expected to take longer than 30 min (system tests, slow runners), use `run_in_background` and monitor the background task.

### Phase 2: Diagnose

Only reached when `watch-ci.sh` returned exit code `1`.

1. Identify the failing run:
   ```bash
   gh run list --branch <branch> --limit 20 \
     --json databaseId,name,conclusion \
     -q '.[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out") | "\(.databaseId) \(.name)"'
   ```
2. Fetch the failing logs (use a sandbox so the output doesn't flood context):
   ```bash
   gh run view <run_id> --log-failed
   ```
3. Match against known regression patterns:
   - `error TS` — TypeScript compilation errors (missing async, null vs undefined, unused vars)
   - `CHECK constraint failed: resource IN` — Permission resource name mismatch
   - `mockReturnValue` on async functions → should be `mockResolvedValue`
   - `is not a function` — missing method on repository or wrong import
   - `Cannot read properties of undefined` — null/undefined propagation from Drizzle repos
   - `FAIL` lines — test file names and assertion errors

### Phase 3: Fix

Apply a **minimal targeted fix** — touch ONLY the files related to the failure:

1. **TypeScript errors** — read the file at the error line, understand the type mismatch, fix it
   - `number | null` vs `number | undefined` → add `?? undefined`
   - Missing `async` keyword → add it to the function
   - Unused variable → remove or prefix with `_`
2. **CHECK constraint errors** — verify resource names match the valid list in migration 006
3. **Mock mismatches** — change `mockReturnValue` to `mockResolvedValue` for async functions
4. **Missing methods** — verify the method exists on the repository, add if missing

After fixing:
- Run the failing test file locally first: `node_modules/.bin/vitest run <failing_test_file>`
- If green, run the relevant suite: `npm test 2>&1 | tail -5`
- Commit and push: `git add -A && git commit -m "fix: <describe>" && git push`

### Phase 4: Re-monitor

After pushing the fix:
1. Wait ~30 seconds for CI to pick up the new commit (otherwise the script may observe the old run)
2. Run `bash scripts/watch-ci.sh -q <PR_NUMBER>` again — back to Phase 1's exit-code dispatch
3. **Maximum 3 fix cycles** — if CI is still red after 3 attempts, stop and report what was tried

### Reporting

When complete (success or max attempts reached), output a summary:

```
## CI Monitor Report for PR #XXXX

**Branch:** <branch_name>
**Result:** ✓ GREEN / ✗ STILL RED after N attempts

### Actions Taken
1. [Cycle 1] Fixed: <description> — Files: <list>
2. [Cycle 2] Fixed: <description> — Files: <list>

### Final CI Status
- PR Tests: PASS/FAIL
- CI: PASS/FAIL
- Claude Code Review: PASS/FAIL
```

## Important Rules

- **Never force-push** — always regular push
- **Never modify files unrelated to the failure** — minimal fixes only
- **Always run failing tests locally before pushing** — don't push blind fixes
- **Check that the branch is up to date** before applying fixes
- **Don't poll `gh run list` in a loop yourself.** Delegate the wait to `scripts/watch-ci.sh -q <PR>` and dispatch on its exit code. That's the whole point of the script — it keeps polling output out of the model's context.
