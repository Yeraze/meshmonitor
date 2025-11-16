# UserScriptsGallery Component

A Vue component for displaying and browsing community-contributed Auto Responder scripts in the MeshMonitor documentation site.

## Overview

The `UserScriptsGallery` component provides an interactive gallery interface for users to discover, search, filter, and view Auto Responder scripts. It features a full-screen modal with two-column layout (details + code viewer), syntax highlighting, and support for scripts hosted in both the main repository and external GitHub repos.

## Usage

The component is registered globally in VitePress and can be used in any markdown file:

```markdown
<UserScriptsGallery />
```

**Example:** See `docs/user-scripts.md`

## Features

- **Full-screen modal gallery** with search and filtering
- **Two-column layout**: Script details on left, syntax-highlighted code on right
- **Dynamic filtering**: By language, tags, and search query
- **Pagination**: Configurable items per page
- **Syntax highlighting**: VS Code Dark+ theme using Prism.js
- **External repo support**: Can fetch scripts from external GitHub repositories
- **Copy functionality**: Copy script code to clipboard
- **Responsive design**: Adapts to mobile and desktop

## Data Structure

Scripts are defined in `docs/.vitepress/data/user-scripts.json`:

```json
{
  "name": "Script Name",
  "filename": "script.py",
  "description": "What the script does",
  "language": "Python",
  "tags": ["Tag1", "Tag2"],
  "githubPath": "examples/auto-responder-scripts/script.py",
  "exampleTrigger": "trigger, trigger {param}",
  "requirements": "Any requirements",
  "author": "Author Name",
  "features": ["Feature 1", "Feature 2"]
}
```

### githubPath Format

- **Main repo**: `examples/auto-responder-scripts/script.py`
- **External repo**: `USERNAME/repo/path/to/script.py` (defaults to main branch)
- **External with branch**: `USERNAME/repo/branch/path/to/script.py`

## Adding New Scripts

1. **Add script entry** to `docs/.vitepress/data/user-scripts.json`
2. **Set githubPath**:
   - Main repo: `examples/auto-responder-scripts/YourScript.py`
   - External: `username/repo/path/to/script.py`
3. **Include all required fields**: name, filename, description, language, tags, etc.
4. **Test** by viewing the gallery and verifying the script appears and code loads correctly

## Technical Details

### Dependencies

- **Vue 3** (Composition API)
- **Prism.js** - Syntax highlighting (dynamically imported)
- **VitePress** - Documentation framework

### Key Functions

- `getSourceUrl(script)` - Builds GitHub URL for viewing source
- `getRawSourceUrl(script)` - Builds raw GitHub URL for fetching code
- `fetchScriptCode(script)` - Fetches and loads script code
- `highlightCode()` - Applies Prism.js syntax highlighting
- `getLanguageAlias(language)` - Maps language names to Prism.js aliases

### State Management

- Uses Vue 3 Composition API with `ref()` and `computed()`
- Filters are reactive and update the displayed scripts automatically
- Modal state prevents body scrolling when open

### Styling

- Uses VitePress CSS variables for theming
- VS Code Dark+ theme for code syntax highlighting
- Responsive breakpoints at 1024px for mobile layout

## File Locations

- **Component**: `docs/.vitepress/theme/UserScriptsGallery.vue`
- **Data**: `docs/.vitepress/data/user-scripts.json`
- **Usage**: `docs/user-scripts.md`
- **Registration**: `docs/.vitepress/theme/index.ts`

## Notes

- Scripts are fetched from GitHub on-demand when viewing details
- Code highlighting is applied after code is loaded
- External repos must be publicly accessible for fetching
- The component handles both main repo and external repo URLs automatically

