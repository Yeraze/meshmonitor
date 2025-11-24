# Git Workflow & Conventions

## Branch Strategy

### Main Branch
- `main` - Production-ready code
- Protected branch with required reviews
- All tests must pass before merge
- Automated releases on merge

### Working Branches
Contributors with expanded permissions (like you) can create branches directly in the main repo:

```bash
# Feature branches
git checkout -b feature/emoji-reactions
git checkout -b feature/traceroute-scheduler

# Bug fix branches
git checkout -b fix/websocket-session-conflict
git checkout -b fix/synology-deployment

# Documentation branches
git checkout -b docs/kubernetes-guide
git checkout -b docs/api-reference

# Chore/maintenance branches
git checkout -b chore/update-dependencies
git checkout -b chore/improve-ci
```

### Git Worktrees for Parallel Work
For working on multiple tasks simultaneously without branch switching, use **git worktrees**:

```bash
# Create separate directories for parallel work
git worktree add ../meshmonitor-feature-search -b feature/message-search
git worktree add ../meshmonitor-fix-dedup -b fix/message-deduplication

# Work in parallel with separate Claude Code sessions
cd ../meshmonitor-feature-search && claude  # Terminal 1
cd ../meshmonitor-fix-dedup && claude       # Terminal 2
```

**See [worktree-guide.md](./worktree-guide.md) for complete parallel development workflow.**

**Benefits:**
- Run multiple Claude Code sessions simultaneously
- No git stash or context switching
- Compare different implementation approaches
- Clean, isolated context per task

### Branch Naming Convention
```
<type>/<brief-description>

Types:
- feature/  - New features
- fix/      - Bug fixes
- docs/     - Documentation
- refactor/ - Code restructuring
- test/     - Test improvements
- chore/    - Maintenance, deps, CI
```

## Commit Message Format

MeshMonitor uses **Conventional Commits** for automated changelog generation and semantic versioning.

### Structure
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types
- `feat:` - New feature (triggers minor version bump)
- `fix:` - Bug fix (triggers patch version bump)
- `docs:` - Documentation only
- `style:` - Formatting, missing semicolons (no code change)
- `refactor:` - Code change that neither fixes nor adds feature
- `perf:` - Performance improvement
- `test:` - Adding or updating tests
- `build:` - Build system or external dependencies
- `ci:` - CI configuration files and scripts
- `chore:` - Other changes that don't modify src or test files

### Scope (Optional)
Indicates which part of the codebase:
- `api:` - Backend API changes
- `ui:` - Frontend UI changes
- `db:` - Database changes
- `tcp:` - TCP protocol/connection
- `docker:` - Docker/deployment
- `deps:` - Dependency updates

### Examples

**Good commits:**
```bash
git commit -m "feat: add emoji reactions to message bubbles"
git commit -m "fix(tcp): resolve reconnection loop on connection timeout"
git commit -m "docs: update deployment guide for Kubernetes"
git commit -m "test(api): add integration tests for traceroute endpoints"
git commit -m "refactor: extract message parsing into service layer"
git commit -m "perf(db): add index on messages.timestamp for faster queries"
git commit -m "ci: add Trivy security scanning to workflow"
```

**With body and footer:**
```bash
git commit -m "fix(websocket): resolve session conflicts on Synology NAS

The WebSocket session management was not properly handling multiple
concurrent connections on Synology's built-in reverse proxy, causing
connection conflicts and dropped messages.

Changes:
- Add session ID to connection tracking
- Implement proper cleanup on disconnect
- Add connection pooling logic

Fixes #123
Relates to #456"
```

**Breaking changes:**
```bash
git commit -m "feat!: change API response format for messages

BREAKING CHANGE: The /api/messages endpoint now returns messages
in a different format. The 'data' field is now 'messages' and
includes pagination metadata.

Migration:
- Update clients to use response.messages instead of response.data
- Pagination info now in response.pagination
"
```

## Workflow Steps

### 1. Create Branch
```bash
# Ensure main is up to date
git checkout main
git pull origin main

# Create and switch to new branch
git checkout -b fix/websocket-session-conflict
```

### 2. Make Changes
```bash
# Edit files
# Run tests: npm run test:run
# Check types: npm run typecheck
# Lint: npm run lint
```

### 3. Commit Changes
```bash
# Stage changes
git add src/services/websocket.ts
git add src/services/websocket.test.ts

# Commit with conventional message
git commit -m "fix(websocket): resolve session conflicts on Synology NAS"
```

### 4. Push Branch
```bash
# First push
git push -u origin fix/websocket-session-conflict

# Subsequent pushes
git push
```

### 5. Create Pull Request
- Go to GitHub repository
- Click "Compare & pull request"
- Fill out PR template (see pr-prep.md)
- Request review from maintainers
- Wait for CI checks to pass

### 6. Address Review Feedback
```bash
# Make requested changes
git add <files>
git commit -m "fix: address review feedback on error handling"
git push

# If commits get messy, consider squashing later
```

### 7. Merge
Once approved:
- Maintainer will merge (or you if you have permissions)
- Delete branch after merge
- Pull updated main locally

## Advanced Git Techniques

### Interactive Rebase (Clean Up Commits)
```bash
# Before pushing, clean up last 3 commits
git rebase -i HEAD~3

# In editor, you can:
# - pick: keep commit
# - squash: merge into previous
# - reword: change message
# - drop: remove commit
```

### Amend Last Commit
```bash
# Forgot to add a file
git add forgotten-file.ts
git commit --amend --no-edit

# Change commit message
git commit --amend -m "fix(websocket): better description"

# WARNING: Only amend unpushed commits
# If already pushed, you'll need to force push
git push --force-with-lease
```

### Cherry-Pick
```bash
# Apply specific commit from another branch
git cherry-pick <commit-hash>
```

### Stash Work
```bash
# Save work temporarily
git stash save "WIP: websocket refactor"

# List stashes
git stash list

# Apply and remove stash
git stash pop

# Apply without removing
git stash apply stash@{0}
```

### Sync with Main
```bash
# While on feature branch
git fetch origin
git rebase origin/main

# Or use merge if you prefer
git merge origin/main
```

## Collaboration Patterns

### Reviewing PRs
As someone with review permissions:

```bash
# Checkout PR for local testing
git fetch origin pull/123/head:pr-123
git checkout pr-123

# Test locally
npm install
npm run test:run
npm run dev:full

# Leave review on GitHub
# Approve, Request Changes, or Comment
```

### Pair Programming
```bash
# Person A creates branch and pushes
git checkout -b feature/new-ui
# ... make changes ...
git push -u origin feature/new-ui

# Person B pulls and continues
git fetch origin
git checkout feature/new-ui
# ... make more changes ...
git push
```

## Common Scenarios

### Fix Merge Conflicts
```bash
# After git pull or git rebase
# 1. Open conflicting files
# 2. Look for conflict markers:
#    <<<<<<< HEAD
#    your changes
#    =======
#    incoming changes
#    >>>>>>> branch-name

# 3. Resolve conflicts
# 4. Stage resolved files
git add <resolved-files>

# 5. Continue rebase or commit merge
git rebase --continue  # if rebasing
git commit             # if merging
```

### Undo Last Commit (Not Pushed)
```bash
# Keep changes, undo commit
git reset --soft HEAD~1

# Discard changes, undo commit
git reset --hard HEAD~1
```

### Undo Pushed Commit
```bash
# Create new commit that reverses changes
git revert <commit-hash>
git push
```

### Update Fork (If Contributing from Fork)
```bash
# Add upstream remote
git remote add upstream https://github.com/Yeraze/meshmonitor.git

# Sync with upstream
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

## CI/CD Integration

### Automated Workflows

**On Pull Request:**
- PR Tests (quick validation)
- ESLint check
- TypeScript compilation
- Test suite execution

**On Push to Main:**
- Full CI (all Node versions)
- Docker image build
- Security scanning with Trivy
- Package publishing

**On Release Tag:**
- Semantic versioning
- Changelog generation
- GitHub release creation
- Docker image tagging

### Manual Workflow Triggers
Some workflows can be manually triggered from GitHub Actions tab.

## Quick Reference

```bash
# Daily workflow
git checkout main
git pull
git checkout -b feature/my-feature
# ... work ...
npm run test:run
git add .
git commit -m "feat: add my feature"
git push -u origin feature/my-feature
# Create PR on GitHub

# Before requesting review
npm run test:run
npm run typecheck
npm run lint

# After PR approved
git checkout main
git pull
git branch -d feature/my-feature
```

## Git Hooks (Optional)

Create `.git/hooks/pre-commit`:
```bash
#!/bin/sh
npm run lint
npm run typecheck
```

Create `.git/hooks/pre-push`:
```bash
#!/bin/sh
npm run test:run
```

Make executable:
```bash
chmod +x .git/hooks/pre-commit
chmod +x .git/hooks/pre-push
```
