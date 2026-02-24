# Development Documentation

Welcome to the MeshMonitor development documentation. This section covers everything you need to know to contribute to or extend MeshMonitor.

## Getting Started with Development

::: tip Using Claude Code?
If you're using Claude Code as your AI assistant, check out our **[Claude Code Getting Started Guide](/development/claude-getting-started)** - it includes a ready-to-use prompt to help Claude understand the project and get you set up quickly.
:::

### Prerequisites

- Node.js 20 or later (22+ recommended)
- npm
- Git
- A Meshtastic device or `meshtasticd`
- Docker (recommended for development)

### Development Setup

See the [Development Setup guide](/development/setup) for detailed instructions on setting up your development environment.

## Project Structure

```
meshmonitor/
├── src/
│   ├── server/          # Backend Express.js application
│   ├── components/      # React components
│   ├── hooks/           # React custom hooks
│   ├── services/        # Frontend services
│   ├── types/           # TypeScript type definitions
│   └── utils/           # Utility functions
├── docs/                # Documentation (VitePress site)
├── helm/                # Kubernetes Helm charts
├── public/              # Static assets
├── tests/               # Test files
└── docker-compose.yml   # Docker Compose configuration
```

## Key Technologies

### Frontend
- **React 19**: UI framework
- **TypeScript**: Type safety
- **Leaflet**: Interactive maps
- **Recharts**: Data visualization
- **Vite**: Build tool and dev server

### Backend
- **Node.js**: Runtime
- **Express 5**: Web framework
- **TypeScript**: Type safety
- **better-sqlite3**: Database
- **Protobuf**: Meshtastic protocol
- **openid-client**: OIDC authentication

## Development Guides

### [Claude Code Getting Started](/development/claude-getting-started)
**New contributors start here!** Complete guide for developers using Claude Code, including a ready-to-use prompt, setup instructions, project rules, and common troubleshooting.

### [Development Setup](/development/setup)
Complete guide to setting up your local development environment, including Docker and native setups.

### [Architecture](/development/architecture)
Overview of MeshMonitor's architecture, design patterns, and system components.

### [Database](/development/database)
Database schema, migrations, and data models.

### [Authentication](/development/authentication)
Authentication system implementation, including local auth and OIDC.

### [API Documentation](/development/api)
Complete API reference for all endpoints.

## Development Workflow

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then clone
git clone https://github.com/YOUR_USERNAME/meshmonitor.git
cd meshmonitor
```

### 2. Create a Branch

```bash
# Create a feature branch
git checkout -b feature/my-new-feature
```

### 3. Make Changes

```bash
# Start development server
npm run dev:full

# Make your changes...
```

### 4. Test

```bash
# Run tests
npm test

# Run type checking
npm run typecheck

# Run linter
npm run lint
```

### 5. Commit

```bash
# Add changes
git add .

# Commit with descriptive message
git commit -m "feat: add new feature"
```

### 6. Push and Create PR

```bash
# Push to your fork
git push origin feature/my-new-feature

# Create pull request on GitHub
```

## Code Style

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Define types for all function parameters and return values
- Use interfaces for object shapes

### React

- Use functional components with hooks
- Keep components small and focused
- Use custom hooks for reusable logic
- Follow React best practices

### Naming Conventions

- **Files**: `camelCase.ts` for utilities, `PascalCase.tsx` for components
- **Components**: `PascalCase`
- **Functions**: `camelCase`
- **Constants**: `UPPER_SNAKE_CASE`
- **Interfaces/Types**: `PascalCase`

## Testing

MeshMonitor uses Vitest for testing.

### Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm test -- --watch

# With coverage
npm run test:coverage

# UI mode
npm run test:ui
```

### System Tests (End-to-End)

We also have a comprehensive system test suite that verifies the full deployment using Docker.

```bash
# Run the full system test suite (builds fresh Docker image)
./tests/system-tests.sh

# Run tests against your running dev environment (Fast!)
./tests/dev-test.sh

# Run tests against a specific Meshtastic node
TEST_NODE_IP=192.168.1.50 ./tests/system-tests.sh
```

### Writing Tests

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from './myFunction';

describe('myFunction', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });
});
```

## Building

### Development Build

```bash
npm run build
```

### Production Build

```bash
NODE_ENV=production npm run build
npm run build:server
```

### Docker Build

```bash
docker build -t meshmonitor:latest .
```

## Contributing

We welcome contributions! Please:

1. Check existing issues or create a new one
2. Fork the repository
3. Create a feature branch
4. Make your changes
5. Write/update tests
6. Ensure all tests pass
7. Submit a pull request

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding/updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(auth): add OIDC support
fix(map): correct node positioning
docs(readme): update installation instructions
```

## Resources

- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [React Documentation](https://react.dev/)
- [Vitest Documentation](https://vitest.dev/)
- [Meshtastic Documentation](https://meshtastic.org/docs/)
- [Meshtastic Protobufs](https://github.com/meshtastic/protobufs)

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Ask questions or discuss ideas
- **Documentation**: Check this documentation first
- **Code Comments**: Read inline comments in the codebase

## Next Steps

- [Get started with Claude Code](/development/claude-getting-started) - Recommended for new contributors
- [Set up your development environment](/development/setup)
- [Understand the architecture](/development/architecture)
- [Explore the API](/development/api)
- [Review the database schema](/development/database)
