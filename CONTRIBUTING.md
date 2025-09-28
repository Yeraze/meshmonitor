# Contributing to MeshMonitor

Thank you for your interest in contributing to MeshMonitor! This guide will help you get started with development and ensure your contributions meet our quality standards.

## 🚀 Getting Started

### Prerequisites
- Node.js 18.x or 20.x
- npm 9.x or later
- Docker (optional, for container testing)
- A Meshtastic node with HTTP API enabled (for full testing)

### Development Setup

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/meshmonitor.git
   cd meshmonitor
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up your development environment:**
   ```bash
   # Copy environment template
   cp .env.example .env

   # Edit .env with your Meshtastic node details
   ```

4. **Start development servers:**
   ```bash
   # Start both frontend and backend in development mode
   npm run dev:full

   # Or start them separately:
   npm run dev        # Frontend only (Vite)
   npm run dev:server # Backend only (Express)
   ```

## 🧪 Testing Requirements

All pull requests must pass our automated test suite. We maintain high standards for code quality and test coverage.

### Running Tests Locally

Before submitting a PR, ensure all tests pass:

```bash
# Run all tests
npm run test:run

# Run tests in watch mode during development
npm run test

# Run tests with coverage report
npm run test:coverage

# Run specific test files
npm run test:run src/services/database.test.ts

# Run tests with UI (great for debugging)
npm run test:ui
```

### Test Categories

1. **Unit Tests**: Test individual functions and components
   - Database operations (`src/services/database.test.ts`)
   - React components (`src/components/*.test.tsx`)
   - API endpoints (`src/server/*.test.ts`)

2. **Type Checking**: Ensure TypeScript types are correct
   ```bash
   npm run typecheck
   ```

3. **Linting**: Follow our code style guidelines
   ```bash
   npm run lint
   ```

### Writing Tests

When adding new features, include appropriate tests:

```typescript
// Example test structure
describe('YourFeature', () => {
  it('should handle normal cases', () => {
    // Test implementation
  });

  it('should handle edge cases', () => {
    // Test edge cases
  });

  it('should handle errors gracefully', () => {
    // Test error handling
  });
});
```

## 🔄 Pull Request Process

### Before Submitting

1. **Ensure all tests pass:**
   ```bash
   npm run test:run
   npm run typecheck
   npm run lint
   ```

2. **Update documentation** if you've changed APIs or added features

3. **Test your changes** with a real Meshtastic node if possible

4. **Build the project** to ensure it compiles:
   ```bash
   npm run build
   npm run build:server
   ```

### PR Guidelines

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

2. **Write clear commit messages:**
   ```
   feat: add telemetry export feature
   fix: resolve database connection timeout
   docs: update API documentation
   test: add tests for message service
   ```

3. **Keep PRs focused**: One feature or fix per PR

4. **Update tests**: Add or update tests for your changes

5. **Document your changes**: Update relevant documentation

### PR Title Format

Use conventional commit format for PR titles:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Maintenance tasks

## 🤖 Automated Checks

Our CI/CD pipeline runs automatically on all PRs:

### GitHub Actions Workflows

1. **PR Tests** (`pr-tests.yml`)
   - Runs on every PR
   - Quick validation of changes
   - Type checking and unit tests

2. **Full CI** (`ci.yml`)
   - Comprehensive testing
   - Multiple Node.js versions
   - Docker build validation
   - Security scanning

3. **Release Pipeline** (`release.yml`)
   - Runs on version tags
   - Full test suite
   - Multi-platform Docker builds
   - Automated release notes

### Status Checks

All PRs must pass these checks:
- ✅ All tests passing
- ✅ TypeScript compilation successful
- ✅ Linter warnings resolved (or documented)
- ✅ Docker build successful
- ✅ Security scan clean

## 📁 Project Structure

```
meshmonitor/
├── src/
│   ├── components/      # React components
│   ├── server/          # Express backend
│   ├── services/        # Shared services
│   └── test/           # Test utilities
├── docs/               # Documentation
│   └── architecture/   # System architecture docs
├── public/            # Static assets
├── .github/          # GitHub Actions workflows
└── tests/           # Additional test files
```

## 🐛 Reporting Issues

When reporting issues, please include:

1. **Environment details:**
   - Node.js version
   - Operating system
   - Browser (for frontend issues)
   - Meshtastic firmware version

2. **Steps to reproduce**

3. **Expected vs actual behavior**

4. **Error messages and logs**

5. **Screenshots** (if applicable)

## 💡 Feature Requests

We welcome feature requests! Please:

1. Check existing issues first
2. Describe the use case
3. Explain the expected behavior
4. Consider implementation complexity

## 🏗️ Development Tips

### Hot Reloading
Both frontend and backend support hot reloading in development mode.

### Database Development
```bash
# Reset database during development
rm data/meshmonitor.db
# The database will be recreated on next start
```

### Docker Development
```bash
# Build and test Docker image locally
docker build -t meshmonitor:local .
docker run -p 8080:3001 meshmonitor:local
```

### Debugging

1. **Frontend debugging**: Use React Developer Tools
2. **Backend debugging**: Use Node.js inspector
   ```bash
   node --inspect dist/server/server.js
   ```
3. **Test debugging**: Use Vitest UI
   ```bash
   npm run test:ui
   ```

## 📝 Code Style

We use ESLint and TypeScript for code quality:

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Add types for all function parameters and returns
- Use meaningful variable names
- Add comments for complex logic
- Keep functions small and focused

## 🙏 Thank You!

Your contributions make MeshMonitor better for everyone. We appreciate your time and effort in improving this project!

If you have questions, feel free to:
- Open an issue for discussion
- Ask in pull request comments
- Refer to existing code for patterns

Happy coding! 🚀