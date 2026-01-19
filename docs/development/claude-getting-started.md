# Claude Code Development Guide for MeshMonitor

This guide provides step-by-step instructions for new developers to set up MeshMonitor for development work using Claude Code as an AI assistant.

---

## Quick Start Prompt for Claude

New contributors can copy and paste this prompt into Claude Code to get oriented with the project:

```
I'm a new contributor to MeshMonitor. Please help me get started by:

1. Reading the project instructions in /CLAUDE.md
2. Reviewing docs/development/claude-getting-started.md for the full setup guide
3. Reading docs/ARCHITECTURE_LESSONS.md to understand critical patterns

Then give me a summary of:
- What MeshMonitor is and its tech stack
- How to set up my development environment (I'll tell you if I'm using DevContainer or manual setup)
- The key rules I need to follow when contributing
- Common pitfalls to avoid

I have the repo cloned and ready to configure.
```

**After running this prompt**, Claude will understand the project context and can help you with:
- Environment setup and troubleshooting
- Understanding the codebase architecture
- Implementing features following project patterns
- Preparing PRs with proper testing

---

## Overview

MeshMonitor is a full-stack web application for monitoring Meshtastic mesh networks over IP. It consists of:

- **Frontend**: React 19 + TypeScript + Vite 7
- **Backend**: Node.js + Express 5 + TypeScript
- **Database**: SQLite (better-sqlite3)
- **Container**: Docker with multi-architecture support

## Prerequisites

Before starting, ensure you have:

- **Node.js 20+** (22+ recommended)
- **npm** (comes with Node.js)
- **Git** with submodule support
- **Docker** and **Docker Compose** (for containerized development)
- A Meshtastic device with WiFi/Ethernet connectivity **OR** `meshtasticd` for virtual testing

---

## Quick Start: DevContainer (Recommended)

The easiest way to get started is using the DevContainer, which provides a fully configured environment.

### VS Code / Cursor

1. Install the "Dev Containers" extension
2. Open this project in VS Code/Cursor
3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
4. Select **"Dev Containers: Reopen in Container"**
5. Wait for container to build (2-5 minutes first time)
6. Run `npm run dev:full` to start development

The DevContainer automatically:
- Initializes Git submodules (`protobufs/` directory)
- Installs npm dependencies
- Creates `.env` from `.env.example`
- Installs VS Code extensions (ESLint, Prettier, Vitest, etc.)
- Makes Docker available for testing
- Installs Claude Code CLI

---

## Manual Setup

If not using DevContainer, follow these steps:

### Step 1: Clone with Git Submodules

**Critical**: MeshMonitor uses Git submodules for Meshtastic protocol definitions. You **must** include submodules:

```bash
git clone --recurse-submodules https://github.com/Yeraze/meshmonitor.git
cd meshmonitor
```

**If you already cloned without submodules:**

```bash
git submodule update --init --recursive
```

**Verify submodules are initialized:**

```bash
ls protobufs/meshtastic/mesh.proto
# Should show the file exists
```

### Step 2: Install npm Dependencies

```bash
npm install
```

This installs all frontend and backend dependencies defined in `package.json`.

### Step 3: Configure Environment Variables

Create a `.env` file from the template:

```bash
cp .env.example .env
```

**Required configuration** - Edit `.env` and set:

```bash
# Your Meshtastic node's IP address (required)
MESHTASTIC_NODE_IP=192.168.1.100

# TCP port (default is 4403)
MESHTASTIC_TCP_PORT=4403
```

**Optional but useful for development:**

```bash
PORT=3001                    # Backend API port
TZ=America/New_York          # Timezone for timestamps
```

### Step 4: Start Development Servers

**Option A: Both servers together (recommended)**

```bash
npm run dev:full
```

This starts both frontend (Vite) and backend (Express) with hot reload.

**Option B: Separate terminals**

```bash
# Terminal 1: Frontend
npm run dev

# Terminal 2: Backend
npm run dev:server
```

### Step 5: Access the Application

- **Frontend (dev server)**: http://localhost:5173
- **Backend API**: http://localhost:3001

The Vite dev server proxies API requests to the Express backend automatically.

---

## Docker Development

For testing the full containerized deployment (closer to production):

### Build and Run

```bash
# Build from local code
docker compose -f docker-compose.dev.yml build

# Start the container
docker compose -f docker-compose.dev.yml up -d

# Access at http://localhost:8081/meshmonitor
```

**Important Notes:**
- Development Docker uses port **8081** (to avoid conflicts with DevContainer)
- The `BASE_URL` is configured as `/meshmonitor` for testing subfolder deployments
- You cannot run Docker AND `npm run dev:full` simultaneously (port conflicts)

### Verify Your Code Is Deployed

After starting Docker, verify the correct code is running:

```bash
docker compose -f docker-compose.dev.yml logs meshmonitor | head -20
```

Look for the version number in the startup logs.

---

## Running Tests

### Unit Tests

```bash
npm run test           # Watch mode
npm run test:run       # Single run (CI mode)
npm run test:coverage  # With coverage report
npm run test:ui        # Interactive Vitest UI
```

### System Tests

The full system test suite validates the complete deployment:

```bash
./tests/system-tests.sh
```

This script:
1. Builds a fresh Docker image
2. Runs Quick Start tests
3. Runs Reverse Proxy tests
4. Runs Virtual Node tests
5. Runs Backup/Restore tests
6. Produces a test report

**Note**: The system tests require a specific hardware/network setup that may not be available to all contributors.

**For PRs involving core functionality or node communication changes:**
- Request @Yeraze to run the system tests on your PR
- Tag the PR with a comment like: "This PR modifies node communication - requesting @Yeraze to run system tests"
- The test results will be posted back on the PR

### Type Checking and Linting

```bash
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
```

---

## Key Documentation to Review

Before implementing features, review these critical documents:

| Document | When to Read |
|----------|--------------|
| [ARCHITECTURE_LESSONS.md](/ARCHITECTURE_LESSONS) | **Before ANY** node communication, state management, backup/restore, or async operations |
| [SYSTEM_ARCHITECTURE.md](/architecture/SYSTEM_ARCHITECTURE) | Understanding overall system design |
| [API Documentation](/development/api) | Working with REST API endpoints |
| [SCHEMA.md](/database/SCHEMA) | Database schema and models |
| [AUTHENTICATION.md](/AUTHENTICATION) | Auth implementation details |
| [FAQ.md](/faq) | Common issues and solutions |

---

## Claude Code Instructions

When using Claude Code for development on this project, these rules are enforced via `CLAUDE.md`:

### Critical Rules

1. **Review ARCHITECTURE_LESSONS.md first** - Before implementing node communication, state management, backup/restore, or async operations

2. **Backend-only node communication** - The frontend NEVER talks directly to the Meshtastic node. All node communication goes through the backend.

3. **Use Docker for development** - Start the dev environment via Docker and always build first

4. **No direct pushes to main** - Always create a branch for your work

5. **System tests for core changes** - For PRs involving core functionality or node communication, request @Yeraze to run system tests

6. **Testing channel** - When sending test messages, use the "gauntlet" channel. **Never send on Primary!**

7. **BASE_URL in testing** - The webserver has `BASE_URL=/meshmonitor` configured for testing

8. **Version updates** - When updating versions, change: `package.json`, Helm chart, Tauri config, then regenerate `package-lock.json`

### Context for Claude

The project includes comprehensive instructions in:
- `/CLAUDE.md` - Project-level instructions
- `/.claude/instructions.md` - Detailed agent context (if using DevContainer)

---

## Common Problems and Solutions

### Submodule Issues

**Problem**: Protobuf-related errors or missing files

```bash
# Force update submodules
git submodule foreach --recursive git clean -fxd
git submodule update --init --recursive --force

# Verify
ls protobufs/meshtastic/mesh.proto
```

### Port Already in Use

**Problem**: "Port 5173 is in use" or "Port 3001 is in use"

```bash
# Find what's using the port
lsof -i :5173
lsof -i :3001

# Kill the process
kill -9 <PID>

# Or stop conflicting Docker containers
docker compose -f docker-compose.dev.yml down
```

### Docker and npm Running Simultaneously

**Problem**: Strange behavior, connection issues

You cannot run both the Docker environment and `npm run dev:full` at the same time. They will conflict on ports and the node connection.

**Solution**: Choose one:
```bash
# Stop Docker
docker compose -f docker-compose.dev.yml down

# Then run npm
npm run dev:full
```

Or vice versa.

### Node Version Issues

**Problem**: Errors about unsupported Node.js features

```bash
# Check version
node --version  # Should be v20.x.x or higher

# Use nvm to switch
nvm install 22
nvm use 22
```

### Database Issues

**Problem**: Database errors or corruption

```bash
# Development (local)
rm -f data/meshmonitor.db
# Restart dev server - database will be recreated

# Docker
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
```

### TypeScript Errors After Changes

**Problem**: Type errors that don't make sense

```bash
# Clear caches
rm -rf node_modules/.cache

# Full reset
rm -rf node_modules package-lock.json
npm install
```

### Can't Connect to Meshtastic Node

**Problem**: "Cannot connect to node" errors

1. **Verify node is reachable:**
   ```bash
   ping 192.168.1.100  # Use your node's IP
   ```

2. **Check TCP port:**
   ```bash
   telnet 192.168.1.100 4403
   # Or: nc -zv 192.168.1.100 4403
   ```

3. **Verify node settings:**
   - Ensure WiFi/Ethernet is enabled on the node
   - Check that TCP is enabled in the node's network settings
   - Confirm port 4403 is accessible

4. **Test with Meshtastic CLI:**
   ```bash
   pip install meshtastic
   meshtastic --host 192.168.1.100
   ```

### CORS/Blank Page Issues

**Problem**: Blank white screen or CORS errors in browser console

Set `ALLOWED_ORIGINS` in your `.env` file:

```bash
# For localhost access
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001

# For Docker on port 8081
ALLOWED_ORIGINS=http://localhost:8081

# Multiple origins
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8081,http://192.168.1.50:8080
```

### Container Doesn't Have sqlite3 Binary

The Docker container doesn't include the `sqlite3` CLI tool. If you need to inspect the database:

```bash
# Copy database out of container
docker cp meshmonitor:/data/meshmonitor.db ./meshmonitor.db

# Use sqlite3 on your host
sqlite3 meshmonitor.db ".tables"
```

Or use the DevContainer which includes sqlite3.

---

## Project Structure Overview

```
meshmonitor/
├── src/
│   ├── server/              # Backend (Express API)
│   │   ├── server.ts        # Main server entry
│   │   ├── routes/v1/       # API endpoints
│   │   ├── models/          # Database models
│   │   ├── services/        # Business logic
│   │   ├── middleware/      # Express middleware
│   │   ├── auth/            # Authentication
│   │   └── migrations/      # DB migrations
│   ├── pages/               # React route pages
│   ├── components/          # React components
│   ├── hooks/               # Custom React hooks
│   ├── services/            # Frontend services
│   ├── contexts/            # React Context
│   ├── types/               # TypeScript types
│   └── test/                # Test utilities
├── tests/                   # Integration tests
│   ├── system-tests.sh      # Full test suite
│   └── unit/                # Unit test files
├── docs/                    # VitePress documentation
├── protobufs/               # Git submodule: Meshtastic protos
├── helm/                    # Kubernetes Helm charts
├── desktop/                 # Tauri desktop app
├── docker-compose.yml       # Production config
├── docker-compose.dev.yml   # Development config
├── Dockerfile               # Production build
├── vite.config.ts           # Vite configuration
├── vitest.config.ts         # Test configuration
├── tsconfig.json            # Frontend TypeScript
├── tsconfig.server.json     # Backend TypeScript
└── CLAUDE.md                # Claude Code instructions
```

---

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start frontend dev server (Vite, port 5173) |
| `npm run dev:server` | Start backend dev server (Express, port 3001) |
| `npm run dev:full` | Start both frontend and backend |
| `npm run build` | Build frontend for production |
| `npm run build:server` | Build backend for production |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run all tests once |
| `npm run test:coverage` | Generate coverage report |
| `npm run docs:dev` | Start documentation server |

---

## Workflow Summary

1. **Clone with submodules**: `git clone --recurse-submodules ...`
2. **Install dependencies**: `npm install`
3. **Configure environment**: `cp .env.example .env` and set `MESHTASTIC_NODE_IP`
4. **Start development**: `npm run dev:full` or use Docker
5. **Create a branch**: `git checkout -b feature/my-feature`
6. **Make changes**: Follow ARCHITECTURE_LESSONS.md patterns
7. **Run unit tests**: `npm run test:run`
8. **Create PR**: Never push directly to main
9. **Request system tests**: For core/node changes, ask @Yeraze to run system tests

---

## Getting Help

- **Documentation**: https://meshmonitor.org/
- **GitHub Issues**: https://github.com/Yeraze/meshmonitor/issues
- **Discord**: https://discord.gg/JVR3VBETQE
- **FAQ**: [/faq](/faq)

---

**Happy coding!** 🚀
