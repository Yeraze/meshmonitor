# Release Notes - v2.16.1

## Overview
This is a minor feature release that improves the emoji reaction picker with a modal UI to prevent accidental sends and expands the available emoji selection.

For detailed release notes, see [RELEASE_NOTES_v2.16.1.md](./RELEASE_NOTES_v2.16.1.md)

## Quick Summary
- Improved emoji picker with modal UI (#500, #503)
- Expanded from 7 to 24 emojis
- Mobile-optimized to prevent accidental sends
- Two-step selection process for better UX

---

# Previous Release - v1.4.0

## Overview
This release included major dependency updates to modernize the codebase and improve compatibility with current Node.js versions.

## Major Updates

### Node.js 22 Support (#35)
- Upgraded from Node 20 to Node 22 (Active LTS)
- Updated Docker base images to use Node 22 Alpine
- Updated CI/CD pipelines to test on Node 20.x and 22.x
- Removed Node 18.x from test matrix (EOL April 2025)

### ESLint 9 Migration (#36)
- Migrated from ESLint 8 to ESLint 9
- Converted from legacy .eslintrc.cjs to flat config format (eslint.config.mjs)
- Upgraded TypeScript ESLint to v8 for ESLint 9 compatibility
- Updated eslint-plugin-react-hooks to v5.2.0
- Added @eslint/compat for plugin compatibility

### React 19 & react-leaflet v5 (#38)
- Upgraded React and react-dom from 18.3.1 to 19.0.0
- Upgraded react-leaflet from 4.2.1 to 5.0.0
- Updated @types/react and @types/react-dom to v19.0.0
- Combined upgrade to resolve peer dependency requirements

### jsdom v27 Upgrade (#37)
- Upgraded jsdom from v24 to v27
- Fixed server tests to be compatible with jsdom v27
- Removed dynamic require() calls in tests
- Added proper TypeScript types to mock functions

## Other Dependency Updates
- **better-sqlite3**: Upgraded to v12.4.1 (required for Node 22+ support)
- **@types/node**: Updated to v24.5.2
- **tsx**: Upgraded to v4.20.6
- **@testing-library/react**: Updated to v16.3.0
- Various other @types packages updated to latest versions

## Breaking Changes
⚠️ **Node.js Version Requirements**
- Node 18 is no longer officially supported (though may still work)
- Minimum recommended version: Node 20.x
- Officially tested on: Node 20.x and 22.x

⚠️ **React 19**
- React 19 may introduce breaking changes
- Review the [React 19 migration guide](https://react.dev/blog/2024/12/05/react-19) for potential impacts

⚠️ **ESLint Configuration**
- ESLint configuration now uses flat config format
- If you have custom ESLint rules, you'll need to migrate them to the new format

## Testing & Quality
- ✅ All 76 tests passing
- ✅ TypeScript compilation successful
- ✅ ESLint configured and passing
- ✅ Docker builds updated and tested
- ✅ CI/CD pipelines updated and passing

## Migration Notes
If you're upgrading from a previous version:

1. **Update Node.js**: Ensure you're running Node 20.x or 22.x
2. **Clean install dependencies**: Run `rm -rf node_modules package-lock.json && npm install`
3. **Update ESLint config**: If you have custom ESLint rules, migrate them to the flat config format
4. **Test thoroughly**: Review React 19 changes and test your UI components

## Contributors
- Dependabot for initial PRs
- Claude Code for dependency coordination and testing

## Full Changelog
- #35: feat: upgrade to Node.js 22 and update CI/CD pipelines
- #36: feat: upgrade to ESLint 9 with flat config migration
- #37: fix: resolve server test failures after jsdom v27 upgrade
- #38: feat: upgrade to React 19 and react-leaflet v5