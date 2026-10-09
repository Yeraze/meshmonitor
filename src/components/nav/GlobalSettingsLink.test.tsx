/**
 * @vitest-environment jsdom
 *
 * GlobalSettingsLink and the label every link to `/settings` shares
 * (#5683 follow-up). Uses the real en.json, so the text a user reads is what
 * is asserted.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const en = JSON.parse(readFileSync(resolve('public/locales/en.json'), 'utf-8')) as Record<string, string>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => en[key] ?? fallback ?? key }),
}));

let grants: (resource: string, action: string, options?: { anySource?: boolean }) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (resource: string, action: string, options?: { anySource?: boolean }) =>
      grants(resource, action, options),
  }),
}));
vi.mock('../../contexts/IconStyleContext', () => ({ useIconStyleOptional: () => 'lucide' }));

import { GlobalSettingsLink } from './GlobalSettingsLink';
import {
  GLOBAL_SETTINGS_NAV_ENTRY,
  GLOBAL_SETTINGS_PATH,
  SOURCE_SETTINGS_NAV_ENTRY,
  globalSettingsNav,
  sourceSettingsNav,
} from './sourceNavEntries';
import { MeshCoreSubToolbar } from '../MeshCore/MeshCoreSubToolbar';
import { ReticulumSubToolbar } from '../Reticulum/ReticulumSubToolbar';

const t = (key: string, fallback: string) => en[key] ?? fallback;
const noop = () => {};

beforeEach(() => {
  grants = () => true;
});

describe('the Global Settings label', () => {
  it('is "Global Settings", from one locale key, and differs from a source gear\'s "Settings"', () => {
    expect(en[GLOBAL_SETTINGS_NAV_ENTRY.labelKey]).toBe('Global Settings');
    expect(globalSettingsNav(t).label).toBe('Global Settings');
    expect(sourceSettingsNav(t).label).toBe('Settings');
    expect(GLOBAL_SETTINGS_NAV_ENTRY.labelKey).not.toBe(SOURCE_SETTINGS_NAV_ENTRY.labelKey);
    expect(GLOBAL_SETTINGS_PATH).toBe('/settings');
  });

  it('is the only key that spells it: the palette group uses the same one', () => {
    expect(Object.entries(en).filter(([, text]) => text === 'Global Settings').map(([key]) => key))
      .toEqual(['nav.global_settings']);
    const sections = readFileSync(resolve('src/components/search/configSections.ts'), 'utf-8');
    expect(sections).toContain('GLOBAL_SETTINGS_NAV_ENTRY.labelKey');
    expect(sections).not.toContain('config_search.global_settings');
  });
});

describe('GlobalSettingsLink', () => {
  const renderLink = (props: React.ComponentProps<typeof GlobalSettingsLink> = {}) =>
    render(<MemoryRouter><GlobalSettingsLink {...props} /></MemoryRouter>);

  it('rail: a link to /settings, named and titled "Global Settings", with its label', () => {
    renderLink();
    const link = screen.getByRole('link', { name: 'Global Settings' });
    expect(link.getAttribute('href')).toBe('/settings');
    expect(link).toHaveAttribute('title', 'Global Settings');
    expect(link).toHaveTextContent('Global Settings');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('collapsed rail: icon only, still named "Global Settings"', () => {
    renderLink({ collapsed: true });
    const link = screen.getByRole('link', { name: 'Global Settings' });
    expect(link.textContent).toBe('');
    expect(link).toHaveAttribute('title', 'Global Settings');
  });

  it('inline: one line that links to /settings', () => {
    renderLink({ variant: 'inline' });
    expect(screen.getByTestId('global-settings-link-inline')).toHaveTextContent(/install-wide settings are in\s+Global Settings/);
    expect(screen.getByRole('link', { name: 'Global Settings' }).getAttribute('href')).toBe('/settings');
  });

  it('asks for settings:read on any source, like the dashboard footer gear', () => {
    const seen: unknown[] = [];
    grants = (resource, action, options) => {
      seen.push([resource, action, options]);
      return true;
    };
    renderLink();
    expect(seen).toContainEqual(['settings', 'read', { anySource: true }]);
  });

  it.each(['rail', 'inline'] as const)('%s: renders nothing without that grant', (variant) => {
    grants = (resource) => resource !== 'settings';
    const { container } = renderLink({ variant });
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to a plain anchor outside a router', () => {
    render(<GlobalSettingsLink />);
    expect(screen.getByRole('link', { name: 'Global Settings' }).getAttribute('href')).toBe('/settings');
  });
});

describe('MeshCore and Reticulum source navs link to Global Settings', () => {
  const NAVS = {
    meshcore: (expanded: boolean) => (
      <MeshCoreSubToolbar view="nodes" onSelect={noop} expanded={expanded} onToggleExpanded={noop} />),
    reticulum: (expanded: boolean) => (
      <ReticulumSubToolbar view="destinations" onSelect={noop} expanded={expanded} onToggleExpanded={noop} sourceMode="own" />),
  };

  it.each(Object.keys(NAVS) as Array<keyof typeof NAVS>)('%s: the link sits in the nav foot, below the items', (name) => {
    const { container } = render(<MemoryRouter>{NAVS[name](true)}</MemoryRouter>);
    const foot = container.querySelector('[data-source-nav-footer]');
    expect(foot).not.toBeNull();
    const link = screen.getByRole('link', { name: 'Global Settings' });
    expect(foot!.contains(link)).toBe(true);
    expect(link.getAttribute('href')).toBe('/settings');
    const settings = container.querySelector('[data-source-nav-item="settings"]')!;
    expect(settings.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(Object.keys(NAVS) as Array<keyof typeof NAVS>)('%s: the per-source gear is still there and still "Settings"', (name) => {
    const { container } = render(<MemoryRouter>{NAVS[name](true)}</MemoryRouter>);
    const settings = container.querySelector('[data-source-nav-item="settings"]')!;
    expect(settings).not.toBeNull();
    expect(settings.textContent).toBe('Settings');
    expect(settings.getAttribute('aria-label') ?? settings.textContent).toBe('Settings');
  });

  it.each(Object.keys(NAVS) as Array<keyof typeof NAVS>)('%s: collapsed rail keeps the link, icon only', (name) => {
    render(<MemoryRouter>{NAVS[name](false)}</MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Global Settings' }).textContent).toBe('');
  });

  it.each(Object.keys(NAVS) as Array<keyof typeof NAVS>)('%s: no link without settings:read', (name) => {
    grants = (resource) => resource !== 'settings';
    render(<MemoryRouter>{NAVS[name](true)}</MemoryRouter>);
    expect(screen.queryByRole('link', { name: 'Global Settings' })).toBeNull();
  });
});
