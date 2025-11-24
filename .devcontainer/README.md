# MeshMonitor DevContainer Setup

This directory contains the development container configuration for MeshMonitor, providing a consistent and reproducible development environment for VS Code, Cursor IDE, GitHub Codespaces, and other devcontainer-compatible tools.

## Quick Start

### VS Code / Cursor
1. Install the "Dev Containers" extension
2. Open this project in VS Code/Cursor
3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
4. Select **"Dev Containers: Reopen in Container"**
5. Wait for container to build (2-5 minutes first time)
6. Run `npm run dev:full` to start development

### GitHub Codespaces
1. Open the repository on GitHub
2. Click **Code** → **Codespaces** → **Create codespace**
3. Wait for environment to initialize
4. Run `npm run dev:full`

## What Gets Configured Automatically

When the devcontainer starts:

✅ **Node.js 22** environment (required for project)
✅ **Git submodules** initialized (`protobufs/` repository)
✅ **npm dependencies** installed
✅ **`.env` file** created from `.env.example` (configure MESHTASTIC_NODE_IP)
✅ **VS Code extensions** installed (ESLint, Prettier, Vitest, etc.)
✅ **Docker** available for testing docker-compose builds
✅ **Claude Code CLI** installed for AI-assisted development

✅ **Python 3** and Apprise for notification testing
✅ **sqlite3** CLI tool for database inspection

## Files in This Directory

| File | Purpose |
|------|---------|
| `devcontainer.json` | Main configuration - extensions, ports, settings |
| `Dockerfile` | Custom image with Node 22, Python, git, Docker CLI |
| `docker-compose.yml` | Volume management and Docker socket mounting |
| `post-create.sh` | Runs once on container creation (setup) |
| `welcome.sh` | Runs on each container start (helpful reminders) |
| `README.md` | This file - usage and maintenance guide |


## Architecture

### Docker-from-Docker (Not Docker-in-Docker)
This devcontainer mounts the **host's Docker socket** (`/var/run/docker.sock`) rather than running a separate Docker daemon inside the container.

**Benefits:**
- Faster builds (shares host's Docker cache)
- Less resource usage (no duplicate Docker daemon)
- Can test `docker-compose.dev.yml` from inside devcontainer

**Limitation:**
- Cannot run devcontainer + `docker-compose.dev.yml` simultaneously (port conflicts)

### Ports Forwarded

| Port | Service | Auto-notify |
|------|---------|-------------|
| 5173 | Vite Dev Server (React) | Yes |
| 3001 | Express API Server | Yes |
| 4404 | Virtual Node (Testing) | Silent |
| 8080 | Docker Testing | Silent |

## DevContainer vs Main Docker Setup

**This devcontainer (`.devcontainer/`):**
- For **local development** in VS Code/Cursor/Codespaces
- Live reload with `npm run dev:full`
- Direct access to source code
- Debugging support
- Hot module replacement

**Main docker-compose files (`docker-compose.dev.yml`, etc.):**
- For **testing full containerized deployment**
- Production-like environment
- Includes Supervisor, Apprise, and all services
- Tests the actual Docker image users will run

**⚠️ Important:** You cannot run both simultaneously - ports will conflict!

## Testing Docker Changes

If you modify `Dockerfile`, `docker-compose.dev.yml`, or other Docker configs:

1. **Exit the devcontainer** (or stop it)
2. **Build and test** the main compose file:
   ```bash
   docker compose -f docker-compose.dev.yml build
   docker compose -f docker-compose.dev.yml up
   ```
3. **Validate** all functionality works
4. **Document changes** if devcontainer needs updating
5. **Test both environments** before creating PR

## Maintenance & Keeping in Sync

### When Project Version Changes

The devcontainer automatically reads the version from `package.json`, but you should verify:

- [ ] `welcome.sh` dynamically reads version (already configured)
- [ ] `.claude/instructions.md` mentions current version (update if needed)

### When npm Scripts Change

Check if these files reference the script:
- [ ] `welcome.sh` - Quick Start Commands section
- [ ] `.claude/instructions.md` - Common Development Commands section
- [ ] This `README.md` - Quick Start section

### When Ports Change

Update port references in:
- [ ] `devcontainer.json` - `forwardPorts` and `portsAttributes`
- [ ] `docker-compose.yml` - `ports` section
- [ ] `welcome.sh` - Ports section
- [ ] `.claude/instructions.md` - Ports section
- [ ] This `README.md` - Ports table

### When Node.js Version Changes

Update:
- [ ] `Dockerfile` - `FROM` base image version
- [ ] `.claude/instructions.md` - Node.js version requirements
- [ ] This `README.md` - mention in "What Gets Configured" section

### When Git Submodules Change

If new submodules are added or paths change:
- [ ] `post-create.sh` - Verify `git submodule update --init --recursive` covers all
- [ ] Update submodule verification checks in `post-create.sh`

### When New Environment Variables Added

Update:
- [ ] `post-create.sh` - If `.env` setup needs customization
- [ ] `.env.example` - Main project file (primary source)
- [ ] `.claude/instructions.md` - Environment variables section

## Troubleshooting

### Container Won't Start

```bash
# Check Docker daemon is running
docker ps

# Rebuild container from scratch
# VS Code: Ctrl+Shift+P → "Dev Containers: Rebuild Container"
```

### Submodules Not Initialized

```bash
# Manually initialize inside container
git submodule update --init --recursive
ls protobufs/meshtastic/mesh.proto  # Verify
```

### Ports Already in Use

```bash
# Check what's using the ports
docker ps                    # Check Docker containers
lsof -i :5173               # Check Vite port (Linux/Mac)
netstat -ano | findstr 5173 # Check Vite port (Windows)

# Stop conflicting processes
docker compose -f docker-compose.dev.yml down
```

### Tests Failing After Setup

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install

# Run tests
npm run test:run
```

### Docker Not Available Inside Container

```bash
# Verify Docker socket is mounted
ls -l /var/run/docker.sock

# Test Docker works
docker ps

# If not working, check docker-compose.yml has:
# volumes:
#   - /var/run/docker.sock:/var/run/docker.sock
```

### `.env` Not Created

```bash
# Manually create from template
cp .env.example .env

# Configure your Meshtastic node IP
# Edit .env and set MESHTASTIC_NODE_IP=192.168.1.100
```

## CI/CD Considerations

**This devcontainer does NOT affect CI/CD pipelines.**

- GitHub Actions and other CI systems run commands directly
- They don't use devcontainer configurations
- Your `.github/workflows/` files are unaffected
- CI uses its own Node 22 setup and Docker environment

The devcontainer is **only for local development** in compatible IDEs.

## Container Management

### Starting the DevContainer

**VS Code / Cursor:**
- Open project → `Ctrl+Shift+P` → "Dev Containers: Reopen in Container"
- Container builds and starts automatically

### Stopping the DevContainer

The container keeps running until you explicitly stop it.

**Option 1: VS Code / Cursor Command Palette**
```
Ctrl+Shift+P → "Dev Containers: Close Remote Connection"
```
This closes your IDE connection but **container keeps running in background**.

**Option 2: Stop Container (Recommended)**
```
Ctrl+Shift+P → "Remote: Close Remote Connection"
```
Then stop via Docker:
```bash
# From host terminal
docker ps                                    # Find container ID
docker stop <container-id>                   # Stop container
```

**Option 3: Docker Desktop (Easiest)**
- Open Docker Desktop
- Find "meshmonitor_devcontainer" under Containers
- Click **Stop** button

### Rebuilding the DevContainer

When you change Dockerfile, devcontainer.json, or need fresh start:

**VS Code / Cursor:**
```
Ctrl+Shift+P → "Dev Containers: Rebuild Container"
```

**Full cleanup (if rebuild fails):**
```bash
# From host terminal
docker compose -f .devcontainer/docker-compose.yml down -v
docker compose -f .devcontainer/docker-compose.yml build --no-cache
# Then "Reopen in Container" in VS Code/Cursor
```

### Deleting the DevContainer

**Remove container + volumes:**
```bash
# From host terminal
docker compose -f .devcontainer/docker-compose.yml down -v
```

**Remove images too:**
```bash
docker compose -f .devcontainer/docker-compose.yml down -v --rmi all
```

**Via Docker Desktop:**
- Containers → Select "meshmonitor_devcontainer" → Delete
- Volumes → Delete "meshmonitor_devcontainer_node_modules-cache"

### Container Lifecycle Summary

| Action | Method | Container State After |
|--------|--------|----------------------|
| Open in Container | Command Palette | Running |
| Close IDE | Close window | **Still Running** |
| Stop Container | Docker CLI/Desktop | Stopped (can restart) |
| Delete Container | `docker compose down -v` | Deleted (rebuild needed) |

**Important:** Closing VS Code/Cursor does NOT stop the container - use Docker commands or Docker Desktop.

### Helper Scripts

We provide shell scripts in `.devcontainer/` to simplify these tasks. Run these from the project root or the `.devcontainer` directory:

| Script | Description |
|--------|-------------|
| `./.devcontainer/scripts/stop.sh` | Stops the running container (safe). |
| `./.devcontainer/scripts/clean.sh` | Stops container and **removes volumes** (fixes corruption). |
| `./.devcontainer/scripts/reset.sh` | Runs clean, then rebuilds the container image (fresh start). |

**Usage Example:**
```bash
# Fix a broken environment
./.devcontainer/scripts/reset.sh
```

## Integration with AI Coding Assistants

This devcontainer is optimized for AI-assisted development with **hybrid Claude Code CLI support**.

### Claude Code CLI Usage Patterns

The devcontainer supports **two usage patterns** for Claude Code CLI:

#### Pattern 1: Local Claude Code → Devcontainer (Desktop Development)

**When to use**: VS Code, Cursor, or local development on your desktop/laptop

**How it works**:
1. Claude Code CLI runs on **your host machine** (your local install)
2. Connects to the devcontainer like VS Code does
3. Reads `.claude/instructions.md` from the mounted workspace
4. Executes commands inside the container automatically
5. **No installation needed in the container**

**Example**:
```bash
# On your host machine
claude "add a new API endpoint for user profiles"

# Claude Code connects to devcontainer and runs commands there
```

**Benefits**:
- Use your existing Claude Code installation
- Simpler setup
- Works with your API keys and configuration
- No container rebuilds needed for Claude updates

#### Pattern 2: Claude Code Inside Container (Always Available)

**When to use**: Working directly in the devcontainer terminal, GitHub Codespaces, or when you prefer in-container execution

**How it works**:
1. Claude Code CLI is **always installed** during container creation
2. Run `claude` command directly in the container terminal at `/workspace`
3. Works in local devcontainers, Codespaces, and remote servers
4. Automatically installed via `post-create.sh`

**First-time authentication** (required on first run):
```bash
# Inside the devcontainer terminal
cd /workspace
claude

# You'll be prompted to authenticate - choose one:
# 1. OAuth (recommended): Browser-based authentication with Anthropic
# 2. API Key: Paste your ANTHROPIC_API_KEY from https://console.anthropic.com
```

**Authentication persists** across:
- Container restarts (credentials stored in volume)
- All workspace sessions
- Until explicitly logged out

**Example usage**:
```bash
# First time - authenticate via OAuth or API key
claude "analyze the architecture and suggest improvements"

# Subsequent usage - no authentication needed
claude "run the test suite and fix any failures"
```

**Benefits**:
- Works in any environment (local, Codespaces, remote)
- Consistent experience for all developers
- No manual installation needed
- OAuth authentication is more secure than API keys

**Using GitHub Codespaces Secrets** (optional):

For API key authentication in Codespaces, set `ANTHROPIC_API_KEY` as a Codespaces secret:
1. Go to GitHub Settings → Codespaces → Secrets
2. Add `ANTHROPIC_API_KEY` with your key
3. Claude Code CLI will detect it automatically (no OAuth prompt)

#### Pattern 3: Both Patterns Work Simultaneously

You can use **both patterns** in the same project:

- **Host Claude Code**: Great for quick tasks, integrates with VS Code/Cursor
- **Container Claude Code**: Great for terminal workflows, automation scripts, MCP integration

Both have access to the same workspace and `.claude/instructions.md` context.

### Other AI Assistants

- **Cursor IDE**: Reads `.claude/instructions.md` via settings (no duplication needed)
- **GitHub Copilot**: Works normally with all extensions available
- **VS Code Continue**: Has access to full project context via workspace mount
- **Codeium**: Compatible with devcontainer environment

### What AI Agents Get

All AI coding assistants benefit from:
- ✅ Consistent environment (same Node, npm, tools)
- ✅ Access to `.claude/instructions.md` (comprehensive project context)
- ✅ Git submodules pre-initialized
- ✅ Docker-from-Docker for testing builds

- ✅ Pre-configured linting and formatting
- ✅ Virtual Node for Meshtastic testing



## VS Code Extensions Included

| Extension | Purpose |
|-----------|---------|
| ESLint | Linting (project uses ESLint 9) |
| Prettier | Code formatting |
| Tailwind CSS IntelliSense | CSS IntelliSense for Tailwind |
| TypeScript | TypeScript language support |
| Vitest Explorer | Test runner integration |
| Error Lens | Inline error display |
| GitLens | Git history and blame |
| Docker | Docker support |
| Code Spell Checker | Catch typos |

## Using Secrets in GitHub Codespaces

For secure automation workflows with Claude Code CLI, API keys, and sensitive configuration:

### Setting Up Codespaces Secrets

**Repository Secrets** (shared across team):
1. Go to your GitHub repository
2. **Settings** → **Secrets and variables** → **Codespaces**
3. Click **New repository secret**
4. Add secrets like `SESSION_SECRET`, etc.

**User Secrets** (personal, not shared):
1. Go to your GitHub profile
2. **Settings** → **Codespaces**
3. Click **New secret**
4. Add personal API keys (e.g., `ANTHROPIC_API_KEY`)

### Accessing Secrets in DevContainer

Secrets are automatically available as environment variables in Codespaces:

```bash
# In Codespaces terminal
echo $ANTHROPIC_API_KEY  # Available automatically
claude "write a test for the login flow"  # Uses your API key
```

### Mapping Secrets to DevContainer

To explicitly map secrets, add to `devcontainer.json`:

```json
"remoteEnv": {
  "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}",
  "DATABASE_ENCRYPTION_KEY": "${localEnv:DATABASE_ENCRYPTION_KEY}"
}
```

**Note**: The devcontainer already maps `NODE_ENV`. Add others as needed for your workflow.

### Best Practices

- ✅ **Do**: Use Codespaces secrets for API keys, tokens, and credentials
- ✅ **Do**: Use repository secrets for shared team configuration
- ✅ **Do**: Use user secrets for personal API keys
- ❌ **Don't**: Commit secrets to `.env` files (use `.env.example` as template)
- ❌ **Don't**: Share your `ANTHROPIC_API_KEY` in repository secrets (use user secrets)

### Example: Claude Code Automation in Codespaces

```bash
# 1. Add ANTHROPIC_API_KEY as user secret in GitHub
# 2. Open repository in Codespaces
# 3. Claude Code CLI auto-installed with API key available
# 4. Run automated workflows:

claude "analyze test coverage and add missing tests"
claude "implement the user profile feature following ARCHITECTURE_LESSONS.md"
claude "run the full test suite and fix any failures"

# All commands use your API key from Codespaces secrets
```

## Additional Resources

- **Project Documentation**: See `docs/` directory
- **Architecture Patterns**: `docs/ARCHITECTURE_LESSONS.md` (essential reading!)
- **Contributing Guide**: `CONTRIBUTING.md`
- **AI Agent Instructions**: `.claude/instructions.md`
- **Main README**: `README.md` (project root)

## Getting Help

- **DevContainer Issues**: Check VS Code's Dev Containers documentation
- **Project Issues**: https://github.com/Yeraze/meshmonitor/issues
- **Discussions**: https://github.com/Yeraze/meshmonitor/discussions

---

**Happy coding!** 🚀

This devcontainer configuration was created to provide a consistent, reproducible development environment for all contributors.
