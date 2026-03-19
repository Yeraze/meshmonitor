# CI Monitor & Auto-Fix

Monitor a PR's CI pipeline, auto-diagnose failures, apply targeted fixes, and re-push until green.

## Usage

Invoke with: `/ci-monitor <PR_NUMBER>`

## Instructions

### Phase 1: Monitor

1. Get the PR branch name: `gh pr view $PR_NUMBER --json headRefName -q .headRefName`
2. Ensure you're on that branch: `git checkout <branch> && git pull origin <branch>`
3. Poll CI status every 60 seconds using: `gh run list --branch <branch> --limit 4 --json name,conclusion,status`
4. Display status each cycle: ✓ for success, ✗ for failure, ⏳ for in-progress
5. When all checks complete:
   - If **ALL GREEN**: Report success and stop
   - If **ANY RED**: Proceed to Phase 2

### Phase 2: Diagnose

1. Get the failing run ID: `gh run list --branch <branch> --limit 1 --json databaseId,conclusion -q '.[] | select(.conclusion == "failure") | .databaseId'`
2. Fetch failure logs: `gh run view <run_id> --log-failed 2>&1`
3. Extract error patterns — look for these common regressions:
   - `error TS` — TypeScript compilation errors (missing async, null vs undefined, unused vars)
   - `CHECK constraint failed: resource IN` — Permission resource name mismatch
   - `mockReturnValue` on async functions — Should be `mockResolvedValue`
   - `is not a function` — Missing method on repository or wrong import
   - `Cannot read properties of undefined` — Null/undefined propagation from Drizzle repos
   - `FAIL` lines — Test file names and assertion errors

### Phase 3: Fix

Apply a **minimal targeted fix** — touch ONLY the files related to the failure:

1. For **TypeScript errors**: Read the file at the error line, understand the type mismatch, fix it
   - `number | null` vs `number | undefined` → Add `?? undefined`
   - Missing `async` keyword → Add it to the function
   - Unused variable → Remove or prefix with `_`
2. For **CHECK constraint errors**: Verify resource names match the valid list in migration 006
3. For **Mock mismatches**: Change `mockReturnValue` to `mockResolvedValue` for async functions
4. For **Missing methods**: Check if the method exists on the repository, add if missing

After fixing:
- Run the failing tests locally: `node_modules/.bin/vitest run <failing_test_file>`
- If they pass, run the full suite: `npm test 2>&1 | tail -5`
- Commit: `git add -A && git commit -m "fix: [describe the CI failure]" && git push`

### Phase 4: Re-monitor

After pushing the fix:
1. Wait 30 seconds for CI to pick up the new commit
2. Return to Phase 1
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
- The `scripts/watch-ci.sh` script can be used for simple polling if you just need to wait
