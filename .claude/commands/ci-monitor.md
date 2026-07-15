# CI Monitor & Auto-Fix

Monitor a PR's CI pipeline, auto-diagnose failures, apply targeted fixes, and re-push until green — then review the PR feedback (automated review bots + human reviewers) and address any concerns raised.

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
| `3`  | PR has a **merge conflict** with its base (`mergeable=CONFLICTING`) — CI for the merge ref will never complete | Proceed to Phase 2b (resolve the conflict), do NOT keep waiting on checks |

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

### Phase 2b: Resolve merge conflict (exit 3)

Reached when `watch-ci.sh` exits `3` — the PR is `CONFLICTING` against its base. Waiting longer will never help; resolve it:

1. Confirm and identify the conflicting files:
   ```bash
   gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus
   git -C <worktree> fetch origin main
   git -C <worktree> merge origin/main    # conflicts print here
   ```
2. Resolve each conflicted file **preserving both sides' intent** — main's hunks are already shipped, so adapt OUR changes around them, not vice versa. Repo-specific gotchas:
   - **`src/db/migrations.ts` conflicts usually mean a migration-number collision.** If main claimed our number, renumber OURS to the next free one: `git mv` the `NNN_*.ts` file, update its exported `runMigrationNNN*` function names, the registry entry (`number`, `settingsKey`), and the import path in `migrations.ts`. Grep for the old `NNN_` prefix and `migration_NNN_` key to catch stragglers. (`migrations.test.ts` is registry-derived — no edit needed.)
   - `public/locales/en.json`: keep both sides' keys.
   - `VALID_SETTINGS_KEYS` / `SERVER_ONLY_SETTINGS`: union of both sides.
3. Verify before pushing: `npm run typecheck`, targeted vitest on the touched areas (JSON reporter, `success: true`), `npm run lint:ci`.
4. Commit the merge (regular merge commit — never force-push) and `git push origin <branch>`.
5. Re-run `watch-ci.sh` (back to Phase 1). GitHub may briefly report `mergeable=UNKNOWN` after the push while it recomputes — the script treats that as "keep watching", not a conflict.

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
- If green, run the full suite. **Do NOT trust the `PASS (N) FAIL (0)` summary line** — the rtk wrapper counts only assertion failures, so suite-level (collection/import) failures slip through. Confirm `success: true` via the JSON reporter:
  ```bash
  npx vitest run --reporter=json --outputFile=/tmp/vitest.json >/dev/null 2>&1
  python3 -c "import json; d=json.load(open('/tmp/vitest.json')); print('success:', d['success'], 'passed:', d['numPassedTests'], 'failed:', d['numFailedTests'], 'suitesFailed:', d['numFailedTestSuites'])"
  ```
- **TypeScript check:** use `npx tsc -p tsconfig.server.json --noEmit` for server code. The base `npx tsc --noEmit` reports ~57–60 **pre-existing** frontend errors (TelemetryChart.tsx, etc.) on clean `origin/main` — ignore those; **only NEW errors you introduced matter**. Do not waste cycles "fixing" the pre-existing noise.
- Commit and push: `git add -A && git commit -m "fix: <describe>" && git push`

### Phase 4: Re-monitor

After pushing the fix:
1. Wait ~30 seconds for CI to pick up the new commit (otherwise the script may observe the old run)
2. Run `bash scripts/watch-ci.sh -q <PR_NUMBER>` again — back to Phase 1's exit-code dispatch
3. **Maximum 3 fix cycles** — if CI is still red after 3 attempts, stop and report what was tried

### Phase 5: Review feedback

Once CI is green, the PR can still have **review concerns** that are not CI failures — comments from the Claude Code Review bot, and reviews/inline threads from human reviewers. A green checkmark is not "done"; address the feedback too.

1. Gather the feedback (run after CI is green, and again after each push since new comments may arrive):
   ```bash
   # Top-level reviews (APPROVED / CHANGES_REQUESTED / COMMENTED) + their summary bodies
   gh pr view <PR_NUMBER> --json reviews,comments \
     -q '.reviews[] | "\(.author.login) [\(.state)]: \(.body)"'
   # Inline review comments anchored to specific lines (the bot posts here)
   gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments \
     -q '.[] | "\(.user.login) \(.path):\(.line) — \(.body)"'
   ```
2. **Triage each concern** — do not blanket-apply or blanket-ignore:
   - **Real bug / correctness / security issue** → fix it (same minimal-diff discipline as Phase 3).
   - **Valid improvement** (naming, edge case, missing test, simplification) → apply it.
   - **False positive / out-of-scope / intentional** → do NOT silently ignore. Leave a brief reply on the thread explaining why, so the reviewer sees it was considered.
   - **Ambiguous or a judgment call you're not sure about** → surface it to the user rather than guessing.
3. **Apply fixes** as one or more focused commits (group related concerns; reference the comment, e.g. `address review: <concern>`). Push.
4. **Close the loop on each thread** so reviewers know it's handled — reply with the commit SHA that addressed it, or the reason it won't change:
   ```bash
   gh pr comment <PR_NUMBER> --body "Addressed in <sha>: <what changed>"
   # or reply to a specific inline thread:
   gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments/<comment_id>/replies -f body="..."
   ```
5. Any push re-triggers CI → **go back to Phase 1** and re-verify green before considering the feedback resolved. Re-check for new comments after each round (a review may respond to your fix).
6. **Bound the effort** like the fix loop: at most a few feedback rounds. If concerns are large, contradictory, or you disagree, stop and hand the open items to the user rather than churning.

### Reporting

When complete (success or max attempts reached), output a summary:

```
## CI Monitor Report for PR #XXXX

**Branch:** <branch_name>
**Result:** ✓ GREEN / ✗ STILL RED after N attempts

### Actions Taken
1. [Cycle 1] Fixed: <description> — Files: <list>
2. [Cycle 2] Fixed: <description> — Files: <list>

### Review Feedback
- <reviewer/bot>: <concern> → Addressed in <sha> / Declined (<reason>) / Deferred to user
- (or "No review feedback raised")

### Final CI Status
- PR Tests: PASS/FAIL
- CI: PASS/FAIL
- Claude Code Review: PASS/FAIL

### Open Items (if any)
- <concerns handed back to the user — judgment calls, large refactors, disagreements>
```

## Important Rules

- **Never force-push** — always regular push
- **Never modify files unrelated to the failure** — minimal fixes only
- **Always run failing tests locally before pushing** — don't push blind fixes
- **Check that the branch is up to date** before applying fixes
- **Don't poll `gh run list` in a loop yourself.** Delegate the wait to `scripts/watch-ci.sh -q <PR>` and dispatch on its exit code. That's the whole point of the script — it keeps polling output out of the model's context.
- **Green CI is not the finish line** — check PR review feedback (Phase 5) before declaring done.
- **Never silently ignore a review concern.** Fix it, or reply explaining why not. Don't blindly apply every suggestion either — use judgment and escalate genuine disagreements to the user.
