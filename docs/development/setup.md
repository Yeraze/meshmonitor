# Development Setup

This guide covers setting up a local development environment for contributing to MeshMonitor.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 20+** (Node.js 22+ recommended)
- **npm** (comes with Node.js)
- **Git** with submodule support
- A Meshtastic device connected to your network via IP (WiFi or Ethernet)
- **OR** `meshtasticd` running as a virtual node

## Quick Start

### 1. Clone the Repository

**Important:** MeshMonitor uses Git submodules for protocol definitions. Clone with `--recurse-submodules`:

```bash
git clone --recurse-submodules https://github.com/yeraze/meshmonitor.git
cd meshmonitor
```

**If you already cloned without submodules:**

```bash
git submodule update --init --recursive
```

### 2. Install Dependencies

```bash
npm install
```

This installs all frontend and backend dependencies defined in `package.json`.

### 3. Set Environment Variables

Create a `.env` file or export environment variables:

```bash
export MESHTASTIC_NODE_IP=192.168.1.100  # Your node's IP
export MESHTASTIC_TCP_PORT=4403          # Default Meshtastic port
```

**Optional environment variables:**

```bash
export PORT=3001                         # Backend API port
export TZ=America/New_York              # Timezone for timestamps
```

### 4. Start the Development Server

MeshMonitor has two components that need to run:

**Option 1: Run both together (recommended)**

```bash
npm run dev:full
```

This starts both the frontend (Vite) and backend (Express) in a single terminal using `concurrently`.

**Option 2: Run separately in two terminals**

```bash
# Terminal 1: Frontend (Vite dev server)
npm run dev

# Terminal 2: Backend (Express API)
npm run dev:server
```

### 5. Access the Development Server

Open your browser to:

```
http://localhost:5173  # Frontend (Vite dev server with hot reload)
```

The backend API runs on:

```
http://localhost:3001  # Backend (Express API)
```

**How it works:**
- The Vite dev server (port 5173) proxies API requests to the Express backend (port 3001)
- Frontend changes hot-reload automatically
- Backend changes restart the server automatically (via `tsx --watch`)

## Development Workflow

### Making Changes

1. **Frontend changes** (React components, CSS):
   - Edit files in `src/components/`, `src/App.tsx`, or CSS files
   - Changes hot-reload automatically in the browser
   - No manual refresh needed

2. **Backend changes** (API routes, database):
   - Edit files in `src/server/` or `src/services/`
   - Server automatically restarts via `tsx --watch`
   - Refresh browser to see API changes

3. **Protocol changes** (Meshtastic protobufs):
   - Update submodule: `git submodule update --remote`
   - Regenerate types if needed

### Running Tests

```bash
# Run all tests in watch mode
npm test

# Run tests once (CI mode)
npm run test:run

# Run tests with UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

### Type Checking

```bash
# Check TypeScript types (frontend + backend)
npm run typecheck
```

### Linting

```bash
# Run ESLint
npm run lint
```

### Building for Production

```bash
# Build frontend
npm run build

# Build backend
npm run build:server

# Run production build
npm start
```

## Using with Physical or Virtual Devices

### Virtual Nodes with meshtasticd

If you're developing without physical hardware, use `meshtasticd` for virtual node simulation:

```bash
# Install meshtasticd
pip install meshtasticd

# Run a virtual node
meshtasticd --hwmodel RAK4631

# Point MeshMonitor to localhost
export MESHTASTIC_NODE_IP=localhost
npm run dev:full
```

See the [meshtasticd configuration guide](/configuration/meshtasticd) for more details.

### Serial/USB Devices

For Serial or USB-connected Meshtastic devices, use the [Meshtastic Serial Bridge](/configuration/serial-bridge):

```bash
# Run the serial bridge
docker run -d --device /dev/ttyUSB0:/dev/ttyUSB0 -p 4403:4403 \
  ghcr.io/yeraze/meshtastic-serial-bridge:latest

# Point MeshMonitor to localhost
export MESHTASTIC_NODE_IP=localhost
npm run dev:full
```

### Bluetooth Devices

For Bluetooth Low Energy (BLE) Meshtastic devices, use the [MeshMonitor BLE Bridge](/configuration/ble-bridge):

```bash
# Run the BLE bridge (see BLE Bridge documentation for setup)
docker compose -f docker-compose.ble.yml up -d

# Point MeshMonitor to localhost
export MESHTASTIC_NODE_IP=localhost
npm run dev:full
```

## Development Environment Details

### Project Structure

```
meshmonitor/
├── src/
│   ├── components/          # React components
│   ├── services/           # Services (Meshtastic, Database)
│   ├── server/             # Express server
│   │   ├── auth/           # Authentication logic
│   │   ├── config/         # Configuration handling
│   │   └── middleware/     # Express middleware
│   ├── utils/              # Shared utilities
│   └── App.tsx             # Main React application
├── docs/                   # Documentation (VitePress)
├── tests/                  # Test files
├── data/                   # SQLite database (development)
├── public/                 # Static assets
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript config (frontend)
├── tsconfig.server.json   # TypeScript config (backend)
└── vite.config.ts         # Vite configuration
```

### Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start frontend dev server (Vite) |
| `npm run dev:server` | Start backend dev server (Express) |
| `npm run dev:full` | Start both frontend and backend |
| `npm run build` | Build frontend for production |
| `npm run build:server` | Build backend for production |
| `npm start` | Start production server |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run tests in watch mode |
| `npm run test:ui` | Run tests with interactive UI |
| `npm run test:run` | Run all tests once |
| `npm run test:coverage` | Generate coverage report |
| `npm run docs:dev` | Start VitePress docs server |
| `npm run docs:build` | Build documentation |

### Environment Modes

MeshMonitor behaves differently in development vs production:

**Development Mode** (`NODE_ENV=development` or unset):
- Verbose logging
- Auto-generated SESSION_SECRET (with warning)
- CORS allows `http://localhost:5173` and `http://localhost:3001`
- Secure cookies disabled (works over HTTP)
- Hot reload for frontend
- Auto-restart for backend

**Production Mode** (`NODE_ENV=production`):
- Minimal logging
- SESSION_SECRET required (errors if not set)
- CORS requires explicit ALLOWED_ORIGINS
- Secure cookies enabled (requires HTTPS)
- Optimized build
- Static file serving

## Troubleshooting Development Issues

### Port Already in Use

If you see `Port 5173 is in use` or `Port 3001 is in use`:

```bash
# Find process using port
lsof -i :5173
lsof -i :3001

# Kill process
kill -9 <PID>
```

### Database Issues

Development database is stored in `data/meshmonitor.db`. To reset:

```bash
rm -f data/meshmonitor.db
# Restart dev server - database will be recreated
```

### Submodule Issues

If you see protobuf-related errors:

```bash
# Update submodules
git submodule update --init --recursive

# If that doesn't work, force update
git submodule foreach --recursive git clean -fxd
git submodule update --init --recursive --force
```

### TypeScript Errors

```bash
# Clear TypeScript cache
rm -rf node_modules/.cache

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Node Version Issues

MeshMonitor requires Node.js 20+. Check your version:

```bash
node --version  # Should be v20.x.x or higher
```

Use [nvm](https://github.com/nvm-sh/nvm) to manage Node.js versions:

```bash
nvm install 20
nvm use 20
```

## IDE Setup

### VS Code (Recommended)

**Recommended Extensions:**
- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin)
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

**Workspace Settings** (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

### WebStorm / IntelliJ IDEA

- Enable ESLint: Settings → Languages & Frameworks → JavaScript → Code Quality Tools → ESLint
- Enable TypeScript: Settings → Languages & Frameworks → TypeScript

## Next Steps

- **[Architecture Guide](/development/architecture)** - Understand the system design
- **[Database Schema](/development/database)** - Learn about data structures
- **[API Documentation](/development/api)** - Explore API endpoints
- **[Authentication](/development/authentication)** - Understand auth implementation

## Contributing

Ready to contribute? See the main [CONTRIBUTING.md](https://github.com/yeraze/meshmonitor/blob/main/CONTRIBUTING.md) for:

- Code style guidelines
- Pull request process
- Testing requirements
- CI/CD workflows
