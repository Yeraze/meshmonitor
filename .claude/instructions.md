# MeshMonitor AI Agent Instructions

Quick context for AI coding agents working on MeshMonitor.

**Project**: MeshMonitor - Meshtastic Mesh Network Monitoring Platform
**License**: BSD-3-Clause
**Repository**: https://github.com/Yeraze/meshmonitor

---

## Quick Start

```bash
# DevContainer auto-configures everything
npm run dev:full         # Start React (5173) + Express (3001)

# Before any PR
npm run test:run         # Must pass 100%
npm run typecheck        # No TypeScript errors
npm run lint             # ESLint clean
```

---

## Architecture Essentials

### Stack
- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Node.js 22 + Express + TypeScript
- **Database**: SQLite (better-sqlite3)
- **Protocol**: Meshtastic Protobuf over TCP
- **Theme**: Catppuccin Mocha (DO NOT modify colors)

### Critical Rules

**⚠️ ONLY THE BACKEND TALKS TO MESHTASTIC NODES**

Frontend → Backend API → Command Queue → Meshtastic Node

**Before implementing node communication, state management, or async operations:**
📖 Read `docs/ARCHITECTURE_LESSONS.md` - prevents common mistakes

### Directory Structure
```
src/
├── App.tsx                    # Main React app
├── components/                # React components
├── server/
│   ├── server.ts             # Express server
│   ├── meshtasticManager.ts  # Node communication
│   ├── routes/               # API endpoints
│   └── services/             # Backend services
├── services/                 # Shared services
└── types/                    # TypeScript definitions
```

---

## Git Workflow

### Submodules (IMPORTANT!)
```bash
# Protobufs are a git submodule
git submodule update --init --recursive

# DevContainer auto-initializes submodules
```

### Branch Strategy
- `main` - never push directly
- `feat/feature-name` - new features
- `fix/bug-name` - bug fixes
- `chore/task-name` - maintenance

### Commit Format
```
feat: add new feature
fix: resolve bug
docs: update documentation
test: add tests
refactor: restructure code
chore: maintenance
```

---

## Development

### DevContainer vs Docker Compose

**DevContainer** (`.devcontainer/`):
- VS Code/Cursor development environment
- Uses Docker-from-Docker
- Auto-initializes submodules
- Run `npm run dev:full`

**Docker Compose** (`docker-compose.dev.yml`):
- Testing full containerized app
- Production-like builds
- Includes supervisor, Apprise, etc.

**⚠️ Cannot run both simultaneously - port conflicts!**

### Environment Variables

Development defaults (auto-created in DevContainer):
```bash
ENABLE_VIRTUAL_NODE=true
MESHTASTIC_NODE_IP=localhost
MESHTASTIC_TCP_PORT=4404        # Points to virtual node
```

See `.env.example` for full options.

---

## Testing Requirements

### Unit/Integration Tests
```bash
npm run test:run          # Required before PR
npm run test:coverage     # Coverage report
npm run test:ui           # Visual debugging
```

**Policy**: 100% passing tests required. No exceptions.

### Test Configuration
- Serial execution (prevents OOM)
- 10-second timeout
- `:memory:` database for isolation

### Testing Specific Features

**Message Testing**: Always use "gauntlet" channel, NEVER "Primary"!

**Virtual Node**: Enabled by default (port 4404) for testing

---

## Code Quality

```bash
npm run typecheck         # TypeScript strict mode
npm run lint             # ESLint (warnings allowed, no errors)
```

**Strict TypeScript**:
- No implicit any
- Strict null checks
- No unused vars (use `_` prefix if intentional)

---

## Important Constraints

### 🚨 DO NOT Modify

- **Catppuccin Theme Colors** (`src/styles/catppuccin-mocha.css`)
- **Main Branch** (always use feature branches)

### 🚨 Requirements

- **Node.js 20+** (22 recommended)
- **Submodules Initialized** (protobufs)
- **Tests Passing** (100% before PR)

### 🚨 Known Issues

- No `sqlite3` binary in container (use better-sqlite3 API)
- DevContainer and docker-compose can't run simultaneously

---

## Version Updates

When bumping version:
1. Update `package.json`
2. Update `helm/meshmonitor/Chart.yaml` (version + appVersion)
3. Run `npm install` to regenerate lock file
4. Commit all three files together

---

## Creating Pull Requests

### Checklist
- [ ] Tests pass
- [ ] TypeScript clean
- [ ] ESLint clean
- [ ] Catppuccin colors unchanged
- [ ] Conventional commit format
- [ ] Feature branch (not main)
- [ ] Documentation updated

### PR Template
```markdown
## Summary
Brief description

## Changes
- Bullet points

## Testing
- [ ] Unit tests pass
- [ ] Manually tested

## Related Issues
Fixes #123
```

---

## Common Tasks

### Starting Development
```bash
# DevContainer (recommended)
npm run dev:full

# Or separately
npm run dev               # Frontend (5173)
npm run dev:server        # Backend (3001)
```

### Testing Message Sending
**CRITICAL**: Always test on "gauntlet" channel, NEVER "Primary"!

### Working with Protobufs
```bash
# Update to latest
cd protobufs
git pull origin master
cd ..
git add protobufs
git commit -m "chore: update meshtastic protobufs"
```

---

## Troubleshooting

### Submodule Issues
```bash
git submodule update --init --recursive
ls protobufs/meshtastic/mesh.proto  # Verify
```

### Port Conflicts
```bash
docker ps                    # Check containers
lsof -i :5173               # Check Vite
lsof -i :3001               # Check Express
```

### Test Failures
```bash
rm -rf node_modules package-lock.json
npm install
npm run test:run -- --clearCache
```

---

## Resources

- **Architecture Patterns**: `docs/ARCHITECTURE_LESSONS.md` (MUST READ)
- **DevContainer Guide**: `.devcontainer/README.md`
- **Development Workflow**: `.claude/development.md`
- **Meshtastic Protobufs**: https://github.com/meshtastic/protobufs
- **Catppuccin Theme**: https://github.com/catppuccin/catppuccin

---

## Contact

- **Issues**: https://github.com/Yeraze/meshmonitor/issues
- **Discussions**: https://github.com/Yeraze/meshmonitor/discussions
- **Pull Requests**: https://github.com/Yeraze/meshmonitor/pulls
