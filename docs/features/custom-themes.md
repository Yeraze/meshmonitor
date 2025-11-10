# Custom Themes

MeshMonitor supports creating custom color themes to personalize your monitoring experience. This feature allows you to:

- Create custom themes with 26 color variables
- Clone and modify existing themes
- Import and export themes as JSON
- Validate accessibility compliance (WCAG 2.1)
- Share themes across your organization

## Overview

Custom themes are system-wide, meaning any theme created by an admin is available to all users. The theming system uses CSS custom properties (variables) to apply colors throughout the application.

## Built-in Themes

MeshMonitor comes with 15 built-in themes:
- **Catppuccin**: Mocha, Macchiato, Frappe, Latte
- **Nord**: Nord Dark
- **Dracula**: Dracula
- **Solarized**: Solarized Dark, Solarized Light
- **Gruvbox**: Gruvbox Dark, Gruvbox Light
- **High Contrast**: High Contrast Dark, High Contrast Light
- **Accessibility**: Protanopia, Deuteranopia, Tritanopia

## Permissions

### Admin Users
- Create new custom themes
- Edit custom themes
- Delete custom themes
- Clone any theme (built-in or custom)

### Regular Users
- View and apply any theme
- Clone any theme to create their own (if they have write permission)
- Cannot modify or delete themes

## Creating a Custom Theme

### Method 1: Visual Editor

1. Navigate to **Settings** → **Custom Themes**
2. Click **Create New Theme**
3. Enter a theme name (e.g., "Ocean Blue")
4. Use the visual editor to adjust colors:
   - **Base Colors**: Background and surface colors
   - **Text Colors**: Text and secondary text
   - **Overlay Colors**: UI element overlays and borders
   - **Surface Colors**: Card and panel backgrounds
   - **Accent Colors**: Primary accent colors
   - **Semantic Colors**: Warning, error, and decorative colors

5. View the **Accessibility Check** panel for WCAG compliance
6. Click **Create Theme** to save

### Method 2: JSON Editor

1. Click the **JSON Editor** tab
2. Paste or edit JSON with all 26 color variables:

```json
{
  "base": "#1e1e2e",
  "mantle": "#181825",
  "crust": "#11111b",
  "text": "#cdd6f4",
  "subtext1": "#bac2de",
  "subtext0": "#a6adc8",
  "overlay2": "#9399b2",
  "overlay1": "#7f849c",
  "overlay0": "#6c7086",
  "surface2": "#585b70",
  "surface1": "#45475a",
  "surface0": "#313244",
  "lavender": "#b4befe",
  "blue": "#89b4fa",
  "sapphire": "#74c7ec",
  "sky": "#89dceb",
  "teal": "#94e2d5",
  "green": "#a6e3a1",
  "yellow": "#f9e2af",
  "peach": "#fab387",
  "maroon": "#eba0ac",
  "red": "#f38ba8",
  "mauve": "#cba6f7",
  "pink": "#f5c2e7",
  "flamingo": "#f2cdcd",
  "rosewater": "#f5e0dc"
}
```

3. Click **Create Theme**

## Cloning Themes

To create a variation of an existing theme:

1. Find the theme you want to clone
2. Click the **Clone** button (📋)
3. Edit the colors as desired
4. Give it a new name
5. Click **Create Theme**

**Tip**: Cloning the currently active theme is a great way to start customizing!

## Importing and Exporting Themes

### Export a Theme

1. Open the theme editor
2. Click **Export**
3. Save the `.json` file

### Import a Theme

1. Click **Create New Theme**
2. Click **Import**
3. Select a `.json` theme file
4. Review and adjust as needed
5. Click **Create Theme**

### Theme File Format

```json
{
  "name": "Ocean Blue",
  "slug": "custom-ocean-blue",
  "definition": {
    "base": "#0a1929",
    "text": "#e3f2fd",
    ...
  }
}
```

## Color Variables Reference

### Base Colors
- `base`: Main background color
- `mantle`: Secondary background color
- `crust`: Tertiary background color

### Text Colors
- `text`: Primary text color
- `subtext1`: Secondary text color
- `subtext0`: Tertiary text color

### Overlay Colors
- `overlay2`: Strong overlays
- `overlay1`: Medium overlays
- `overlay0`: Light overlays

### Surface Colors
- `surface2`: Raised surfaces
- `surface1`: Normal surfaces
- `surface0`: Recessed surfaces

### Accent Colors
- `lavender`: Accent color
- `blue`: Primary interactive elements
- `sapphire`: Info elements
- `sky`: Highlight elements
- `teal`: Success elements
- `green`: Positive feedback

### Semantic Colors
- `yellow`: Warning elements
- `peach`: Caution elements
- `maroon`: Important elements
- `red`: Error elements
- `mauve`: Special elements
- `pink`: Decorative elements
- `flamingo`: Decorative elements
- `rosewater`: Decorative elements

## Accessibility Validation

The theme editor includes real-time accessibility checking based on WCAG 2.1 guidelines:

### Compliance Levels

**WCAG AA** (Minimum Standard)
- Normal text: 4.5:1 contrast ratio
- Large text: 3:1 contrast ratio

**WCAG AAA** (Enhanced Standard)
- Normal text: 7:1 contrast ratio
- Large text: 4.5:1 contrast ratio

### Accessibility Report

When creating or editing a theme, the editor shows:

- **Critical Issues**: Must be fixed for usability
- **Warnings**: Recommended improvements
- **Recommendations**: Best practices

**Example Report:**

```
✓ Theme meets WCAG AA standards
⚠ Text on surface background passes AA (4.8:1) but not AAA (7:1 required)
ℹ Consider adjusting color values for AAA compliance
```

## Theme Slug Format

Custom theme slugs must:
- Start with `custom-`
- Contain only lowercase letters, numbers, and hyphens
- Be between 8 and 50 characters

**Valid**: `custom-ocean-blue`, `custom-dark-mode-2024`
**Invalid**: `oceanblue`, `Custom-Theme`, `my_theme`

## Best Practices

### 1. Start with a Similar Theme
Clone a theme that's close to your vision and modify it.

### 2. Test Contrast Ratios
Ensure text is readable on all backgrounds:
- Light text on dark backgrounds
- Dark text on light backgrounds
- Sufficient contrast for UI elements

### 3. Consider Color Blindness
Use the built-in accessibility themes as reference:
- Protanopia (red-green)
- Deuteranopia (red-green)
- Tritanopia (blue-yellow)

### 4. Test in Different Lighting
View your theme in:
- Bright office lighting
- Dim lighting
- Night mode/dark environments

### 5. Get Feedback
Share theme exports with your team and gather feedback.

### 6. Document Your Themes
Export themes with descriptive names and keep a library.

## Troubleshooting

### Theme Not Applying

**Problem**: Selected a custom theme but colors haven't changed.

**Solutions**:
1. Refresh the page (hard refresh: Ctrl+Shift+R / Cmd+Shift+R)
2. Check browser console for errors
3. Verify the theme definition is valid JSON
4. Try switching to a built-in theme, then back to custom

### Low Contrast Warning

**Problem**: Accessibility checker reports low contrast.

**Solutions**:
1. Increase the difference between text and background colors
2. Use the Visual Editor to see real-time changes
3. Refer to WCAG color contrast calculator tools
4. Test with the provided color suggestions

### Theme Deleted Accidentally

**Problem**: Accidentally deleted a custom theme.

**Solutions**:
1. Check if you have an exported JSON file
2. Ask your admin to restore from system backup
3. Recreate from memory or screenshots

### Import Fails

**Problem**: Theme import shows an error.

**Solutions**:
1. Validate the JSON file syntax
2. Ensure all 26 color variables are present
3. Check that color values are valid hex codes (#RRGGBB)
4. Remove any unexpected properties

## API Reference

For programmatic theme management:

### List All Themes
```bash
GET /api/themes
```

### Get Specific Theme
```bash
GET /api/themes/:slug
```

### Create Theme
```bash
POST /api/themes
Content-Type: application/json

{
  "name": "Ocean Blue",
  "slug": "custom-ocean-blue",
  "definition": "{...json...}"
}
```

### Update Theme
```bash
PUT /api/themes/:slug
Content-Type: application/json

{
  "name": "Ocean Blue Updated",
  "definition": "{...json...}"
}
```

### Delete Theme
```bash
DELETE /api/themes/:slug
```

**Note**: All mutation operations require `themes:write` permission.

## Examples

### Example 1: High Contrast Theme

```json
{
  "name": "Ultra High Contrast",
  "slug": "custom-ultra-contrast",
  "definition": {
    "base": "#000000",
    "mantle": "#0a0a0a",
    "crust": "#050505",
    "text": "#ffffff",
    "subtext1": "#e0e0e0",
    "subtext0": "#c0c0c0",
    "overlay2": "#606060",
    "overlay1": "#404040",
    "overlay0": "#303030",
    "surface2": "#404040",
    "surface1": "#303030",
    "surface0": "#202020",
    "lavender": "#bb99ff",
    "blue": "#0099ff",
    "sapphire": "#00ccff",
    "sky": "#00ffff",
    "teal": "#00ff99",
    "green": "#00ff00",
    "yellow": "#ffff00",
    "peach": "#ff9900",
    "maroon": "#cc0066",
    "red": "#ff0000",
    "mauve": "#cc00ff",
    "pink": "#ff00cc",
    "flamingo": "#ff6699",
    "rosewater": "#ffccdd"
  }
}
```

### Example 2: Warm Autumn Theme

```json
{
  "name": "Warm Autumn",
  "slug": "custom-warm-autumn",
  "definition": {
    "base": "#2b1d14",
    "mantle": "#231710",
    "crust": "#1a110c",
    "text": "#f5e6d3",
    "subtext1": "#d4c5b2",
    "subtext0": "#b3a491",
    "overlay2": "#8c7a6a",
    "overlay1": "#6e5c4c",
    "overlay0": "#574736",
    "surface2": "#4a3a2a",
    "surface1": "#3d2e1e",
    "surface0": "#302212",
    "lavender": "#d4a6cc",
    "blue": "#6a89a0",
    "sapphire": "#5c9fa8",
    "sky": "#7eb5c4",
    "teal": "#6ba894",
    "green": "#8ca67c",
    "yellow": "#d4a050",
    "peach": "#d4753e",
    "maroon": "#a8645a",
    "red": "#b8534e",
    "mauve": "#9d7ba8",
    "pink": "#b88ca0",
    "flamingo": "#c49688",
    "rosewater": "#d4aa98"
  }
}
```

## Related Documentation

- [Settings](./settings.md) - Configure application settings including theme selection

## Support

For issues with custom themes:
1. Check the theme validation errors
2. Review the accessibility report
3. Try exporting and re-importing the theme
4. Contact your administrator
5. Report bugs at https://github.com/Yeraze/meshmonitor/issues
