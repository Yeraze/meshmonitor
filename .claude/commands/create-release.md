# Create Release

Create a GitHub release with proper validation, release notes, and workflow monitoring.

## Usage

Invoke with: `/create-release <VERSION>`

Example: `/create-release v3.10.0-RC1`

## Instructions

### Phase 1: Validate

1. Parse the version string. Verify format: `vX.Y.Z` or `vX.Y.Z-suffix` (e.g., `v3.10.0`, `v3.10.0-RC1`, `v3.10.0-DEV1`)
2. Check if a release with this tag already exists: `gh release view <VERSION> 2>/dev/null`. If it exists, stop and report.
3. Determine release type:
   - If version contains `RC` or `DEV` (case-insensitive): **pre-release** (`--prerelease` flag, no `:latest` docker tags)
   - Otherwise: **full release**
4. Verify the version in `package.json` matches. If not, prompt the user.

### Phase 2: Gather Release Notes

1. Find the previous release tag: `gh release list --limit 1 --json tagName -q '.[0].tagName'`
2. Get ALL PRs merged since the previous release: `gh pr list --state merged --search "merged:>=$(gh release view <PREV_TAG> --json createdAt -q .createdAt | cut -dT -f1)" --limit 100 --json number,title,author`
3. Get ALL issues closed since the previous release: `gh issue list --state closed --search "closed:>=$(gh release view <PREV_TAG> --json createdAt -q .createdAt | cut -dT -f1)" --limit 50 --json number,title`
4. Identify new contributors — authors who don't appear in older PRs

### Phase 3: Create Release

1. Write release notes with:
   - Title: `# MeshMonitor <VERSION>`
   - If pre-release: add warning banner
   - **Summary paragraph** (10 sentences max) describing the key changes and fixes
   - Categorized PR list: Features, Bug Fixes, Refactoring, CI/DevOps, Security, Dependencies
   - Link each PR: `#NUMBER`
   - List closed issues under "Issues Resolved"
   - Thank new contributors by GitHub handle
   - Upgrade notes if any breaking changes
   - Full changelog link: `https://github.com/Yeraze/meshmonitor/compare/<PREV_TAG>...<VERSION>`

2. Create the release:
   ```bash
   gh release create <VERSION> --target main --title "<VERSION>" --notes "<NOTES>"
   ```
   Add `--prerelease` if RC or DEV version.

3. Let GitHub create the tag (per CLAUDE.md — do NOT create the tag manually).

### Phase 4: Monitor Release Workflows

1. Wait 30 seconds for workflows to trigger
2. Run `./scripts/watch-release.sh <VERSION>` to monitor
3. When complete:
   - If **ALL GREEN**: Report success
   - If **FAILED**:
     - Fetch failure logs: `gh run view <ID> --log-failed`
     - Analyze the error:
       - **Infrastructure/timeout**: Automatically re-run with `gh run rerun <ID>`
       - **Image not found for platform**: This is a Dockerfile base image issue — prepare a fix and prompt user
       - **Test failure**: Diagnose root cause, prepare fix, prompt user
       - **Auth/permission error**: Report to user, cannot auto-fix

### Phase 5: Report

Output a summary:
```
## Release Report: <VERSION>

**Type:** Pre-release / Full release
**Tag:** <VERSION>
**Previous:** <PREV_TAG>

### Release Workflows
- Release Pipeline: PASS/FAIL
- Docker Build and Publish: PASS/FAIL
- Desktop Release: PASS/FAIL

### Stats
- PRs merged: N
- Issues closed: N
- New contributors: @name1, @name2

### Actions Taken
- (any re-runs or fixes applied)
```

## Important Rules

- Let GitHub create the tag — never `git tag` manually
- RC/DEV versions are ALWAYS pre-releases
- Check for existing release BEFORE creating
- Include ALL PRs and issues since the previous tag, not just recent ones
- Keep the summary paragraph concise (10 sentences max)
- Thank new contributors by their GitHub handle
- If a workflow fails and you re-run it, monitor the re-run too (max 2 retry attempts)
