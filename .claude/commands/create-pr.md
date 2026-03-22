---
name: create-pr
description: Create or update a pull request with full validation — runs tests, reviews docs, creates detailed PR, and monitors CI feedback
---

Create or update a pull request for the current branch. Follow every step below in order.

## Arguments
$ARGUMENTS

If arguments contain a PR number (e.g., "2297" or "#2297"), this is a PR update — push changes and skip to **Step 5**.
If arguments contain descriptive text, use it as context for the PR description.

## Step 1: Validate Before Pushing

### 1a. Run Unit Tests
```bash
npx vitest run
```
All tests MUST pass. If any fail, fix them before proceeding. Do NOT create a PR with failing tests.

### 1b. TypeScript Check
```bash
npx tsc --noEmit
```
Must compile cleanly. Fix any errors.

### 1c. Check for uncommitted changes
```bash
git status
git diff --stat
```
If there are unstaged changes related to the current work, ask the user if they should be committed first.

## Step 2: Review Documentation for Accuracy

Check if the changes affect any documented features. Scan:

1. **Internal docs** — Search `docs/features/`, `docs/configuration/`, and `docs/api/` for content related to the changed files. If the feature behavior changed, note what docs need updating.
2. **VitePress site docs** — Check `docs/.vitepress/config.mts` sidebar entries. If a new feature was added, verify it's referenced in navigation.
3. **CHANGELOG.md** — Does this change warrant a changelog entry?
4. **README.md** — If the change affects setup, configuration, or major features.

If documentation is outdated or missing, update it as part of this PR. Tell the user what you updated and why.

## Step 3: Prepare the Branch

```bash
git log --oneline main..HEAD   # Review all commits on this branch
git diff main...HEAD --stat    # Review full diff from main
```

Ensure:
- Branch is not `main` (never push directly to main)
- Branch has a descriptive name (fix/, feature/, docs/)
- All commits are meaningful

Push the branch:
```bash
git push -u origin $(git branch --show-current)
```

## Step 4: Create the Pull Request

Use `gh pr create` with a detailed description following this structure:

```bash
gh pr create --title "<concise title under 70 chars>" --body "$(cat <<'EOF'
## Summary
<2-4 sentences explaining the INTENT of the change — why this PR exists, not just what files changed>

## Changes
<Bulleted list of specific changes made>

## Issues Resolved
<Link any related issues: "Fixes #NNN" or "Relates to #NNN". If none, state "None">

## Documentation Updates
<List any docs updated as part of this PR, or "No documentation changes needed">

## Testing
- [ ] Unit tests pass (N tests)
- [ ] TypeScript compiles cleanly
- [ ] <Any feature-specific test steps the reviewer should verify>
- [ ] <Manual testing steps if applicable>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Important:**
- Title should be concise and follow conventional commit format (fix:, feat:, chore:, refactor:, docs:)
- Summary explains WHY, not just WHAT
- Always include Issues Resolved section even if "None"
- Testing section should include specific verification steps a reviewer can follow

## Step 5: Monitor CI Feedback

After creating or pushing the PR, wait 5 minutes for CI to run:

```bash
sleep 300
```

Then check CI results:
```bash
gh pr view <PR_NUMBER> --json statusCheckRollup --jq '[.statusCheckRollup[] | {name: .name, status: .status, conclusion: .conclusion}]'
```

Also check for review comments:
```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
```

### Handling CI Findings

**Urgent (fix immediately and push):**
- Test failures
- TypeScript compilation errors
- Security scan failures
- Build failures

After fixing urgent issues, push and return to Step 5 (wait and re-check).

**Non-urgent (prompt user for feedback):**
- Code style suggestions from automated reviewers
- Documentation suggestions
- Performance recommendations
- Refactoring suggestions

Present non-urgent findings to the user with a summary and ask how they'd like to proceed.

## Step 6: Report

Tell the user:
- PR URL
- CI status (all green, or what's pending)
- Any findings that need attention
- Remain on the branch until the PR is reviewed and merged
