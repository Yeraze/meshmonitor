import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Landscape-phone side rail (#6211).
 *
 * The rail used to live only on the Device Configuration page
 * (ConfigurationTab.module.css, #5069/#5073). It now lives with the SectionNav
 * component so every picker surface gets it by wrapping its nav + content in
 * the shared `.shell` / `.body` classes.
 *
 * CSS media-query layout cannot be exercised in jsdom (no real viewport, no
 * `@media` evaluation), so these tests assert the rail rules exist in the
 * shared module and that each consumer opts in through the shared classes —
 * the wiring a refactor could silently drop. The pixel layout itself is
 * verified on a real landscape phone.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('SectionNav landscape rail CSS (#6211)', () => {
  const css = stripComments(readFileSync(join(dir, 'SectionNav.module.css'), 'utf8'));

  it('defines the rail only inside the compact-landscape breakpoint', () => {
    expect(css).toMatch(/@media\s*\(max-height:\s*500px\)\s*and\s*\(orientation:\s*landscape\)/);
  });

  it('turns the shell into a flex row and the nav into a vertical rail', () => {
    expect(css).toMatch(/\.shell\s*\{[^}]*display:\s*flex/);
    // Doubled specificity (.shell :global(.section-nav)) so it beats both the
    // base .section-nav block and App.css's max-width:768px chip-row block.
    expect(css).toMatch(/\.shell\s+:global\(\.section-nav\)\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.shell\s+:global\(\.section-nav\)\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.body\s*\{[^}]*flex:/);
  });

  it('leaves the sticky `top` to the base / pane rules (does not re-answer it)', () => {
    // The rail reshapes the nav but must not set `top`: window-scroll pages
    // keep var(--app-header-height); MeshCore pane views keep their own.
    const railBlock = css.slice(css.indexOf('.shell :global(.section-nav) {'));
    const firstRule = railBlock.slice(0, railBlock.indexOf('}'));
    expect(firstRule).not.toMatch(/\btop:/);
  });

  it('uses only role tokens for colour (no hardcoded hex)', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('SectionNav consumers opt into the shared rail (#6211)', () => {
  const consumers = [
    'ConfigurationTab.tsx',
    'AutomationTab.tsx',
    'SettingsTab.tsx',
    'NotificationsTab.tsx',
    'AdminCommandsTab.tsx',
    'MeshCore/MeshCoreAutomationsView.tsx',
    'MeshCore/MeshCoreConfigurationView.tsx',
  ];

  it.each(consumers)('%s wraps its picker + content in the shared shell/body', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    expect(src, `${file} should import the shared SectionNav layout module`).toMatch(
      /import\s+sectionNavLayout\s+from\s+['"][.][.]?\/SectionNav\.module\.css['"]/,
    );
    expect(src, `${file} should apply the shell class`).toContain('sectionNavLayout.shell');
    expect(src, `${file} should apply the body class`).toContain('sectionNavLayout.body');
  });
});
