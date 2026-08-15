/**
 * NodeIncompleteBadge (#4720) — the badge itself, plus the `isNodeComplete`
 * contract it is driven by.
 *
 * The badge is only as trustworthy as the predicate behind it, and that
 * predicate has two deliberate subtleties that a naive "is the name set?" check
 * would get wrong (see `isNodeComplete` in utils/nodeHelpers.ts):
 *   - a firmware-default `Node !xxxxxxxx` longName means NODEINFO has NOT
 *     arrived, even though longName is non-empty;
 *   - a default shortName (last 4 hex of the id) is perfectly valid and must
 *     NOT count as incomplete.
 * Both are pinned here so the badge can't start lying if the predicate drifts.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { NodeIncompleteBadge } from './NodeIncompleteBadge';
import { isNodeComplete } from '../utils/nodeHelpers';

describe('NodeIncompleteBadge', () => {
  it('renders an inert, labelled indicator (not a button)', () => {
    render(<NodeIncompleteBadge />);

    const badge = screen.getByTestId('node-incomplete-badge');
    expect(badge).toBeInTheDocument();
    // Facts-left / actions-right (#4379): this belongs to the indicator group,
    // so it must not be interactive.
    expect(badge.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(badge).toHaveClass('node-indicator-icon');
  });

  it('carries an accessible explanation, not just a tooltip', () => {
    render(<NodeIncompleteBadge />);
    const badge = screen.getByTestId('node-incomplete-badge');
    // i18n is unconfigured under jsdom, so t() echoes the key — same convention
    // as NodeUnmessageableBadge.test.tsx. A tooltip alone would leave the badge
    // meaningless to a screen reader, hence both attributes.
    expect(badge).toHaveAttribute('title', 'nodes.incomplete_badge');
    expect(badge).toHaveAttribute('aria-label', 'nodes.incomplete_badge');
  });

  it('has its locale key registered, so it renders real copy in the app', () => {
    // The jsdom assertions above pass even if the key was never added to
    // en.json — this is the one that would catch that.
    // Vitest runs from the project root; `import.meta.url` isn't a file: URL
    // after transform, so resolve from cwd instead.
    const en = JSON.parse(
      readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8'),
    ) as Record<string, string>;
    expect(en['nodes.incomplete_badge']).toMatch(/NodeInfo/i);
  });
});

describe('isNodeComplete — the predicate the badge renders', () => {
  const complete = { nodeId: '!433d1ba4', longName: 'Base Station', shortName: 'BASE', hwModel: 43 };

  it('treats a fully populated node as complete (no badge)', () => {
    expect(isNodeComplete(complete)).toBe(true);
  });

  it('treats a firmware-default "Node !xxxxxxxx" longName as INCOMPLETE', () => {
    // Non-empty, but it means NODEINFO never arrived — the case a naive
    // truthiness check on longName would miss.
    expect(isNodeComplete({ ...complete, longName: 'Node !433d1ba4' })).toBe(false);
  });

  it('treats a default-looking shortName as COMPLETE', () => {
    // Firmware uses the last 4 hex chars as the default shortName, so plenty of
    // genuinely-synced nodes look like this. Badging them would be wrong.
    expect(isNodeComplete({ ...complete, shortName: '1ba4' })).toBe(true);
  });

  it('is incomplete when any NODEINFO-derived field is missing', () => {
    expect(isNodeComplete({ ...complete, longName: null })).toBe(false);
    expect(isNodeComplete({ ...complete, shortName: null })).toBe(false);
    expect(isNodeComplete({ ...complete, hwModel: null })).toBe(false);
    expect(isNodeComplete({ ...complete, hwModel: undefined })).toBe(false);
  });

  it('treats hwModel 0 as present — 0 is a real hardware model, not "unset"', () => {
    expect(isNodeComplete({ ...complete, hwModel: 0 })).toBe(true);
  });
});
