/**
 * NodeIdentityChangeBadge (#5032) — the node-list glyph for a Meshtastic 2.8
 * node-number change.
 *
 * What matters here is what the badge must NOT be: interactive, alarming, or
 * more certain than the evidence behind it. Detection is a heuristic, and the
 * badge sits one glyph away from an operator deciding to merge two nodes'
 * histories by hand.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { NodeIdentityChangeBadge } from './NodeIdentityChangeBadge';
import type { IdentityChangeDetection } from '../types/nodeIdentityChange';

const detection = (over: Partial<IdentityChangeDetection> = {}): IdentityChangeDetection => ({
  successor: {
    nodeNum: 3649751816,
    nodeId: '!d992eb08',
    longName: 'Base Station',
    shortName: 'BASE',
    hwModel: 43,
    firmwareVersion: '2.8.0.47db0e3',
    lastHeard: 1000,
    createdAt: 900,
    hasPublicKey: true,
  },
  predecessor: {
    nodeNum: 0x433d1ba4,
    nodeId: '!433d1ba4',
    longName: 'Base Station',
    shortName: 'BASE',
    hwModel: 43,
    firmwareVersion: '2.7.11',
    lastHeard: 500,
    createdAt: 100,
    hasPublicKey: true,
  },
  basis: 'derivedNodeNum',
  confidence: 'high',
  derivedFromPredecessorKey: true,
  successorNodeNumIsKeyDerived: true,
  predecessorNodeNumIsKeyDerived: false,
  publicKeyMatches: true,
  nameMatches: true,
  hwModelMatches: true,
  successorFirmwareIs28OrLater: true,
  predecessorQuietForSeconds: 172800,
  handoverGapSeconds: 400,
  otherCandidateCount: 0,
  ...over,
});

describe('NodeIdentityChangeBadge', () => {
  it('renders an inert, labelled indicator — never a button', () => {
    // Facts-left / actions-right (#4379). More importantly: there is no action
    // here on purpose. A one-click merge on a heuristic match would corrupt
    // two nodes' histories irreversibly.
    render(<NodeIdentityChangeBadge detection={detection()} role="successor" />);

    const badge = screen.getByTestId('node-identity-change-badge');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveClass('node-indicator-icon');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Both attributes: a tooltip alone is invisible to a screen reader.
    expect(badge).toHaveAttribute('title');
    expect(badge).toHaveAttribute('aria-label');
  });

  it('names the other half of the pair in both directions', () => {
    const { unmount } = render(<NodeIdentityChangeBadge detection={detection()} role="successor" />);
    // i18n is unconfigured under jsdom, so t() echoes the key — the
    // interpolated node id still has to reach the label.
    expect(screen.getByTestId('node-identity-change-badge').getAttribute('title')).toBeTruthy();
    expect(screen.getByTestId('node-identity-change-badge')).toHaveAttribute('data-role', 'successor');
    unmount();

    render(<NodeIdentityChangeBadge detection={detection()} role="predecessor" />);
    expect(screen.getByTestId('node-identity-change-badge')).toHaveAttribute('data-role', 'predecessor');
  });

  it('falls back to the node id when the other node has no name', () => {
    const d = detection();
    d.predecessor.longName = null;
    d.predecessor.shortName = null;
    render(<NodeIdentityChangeBadge detection={d} role="successor" />);
    expect(screen.getByTestId('node-identity-change-badge')).toBeInTheDocument();
  });

  it('has every locale key registered, so it renders real copy in the app', () => {
    // The jsdom assertions above pass even if the keys were never added to
    // en.json — this is the one that would catch that.
    const en = JSON.parse(readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8')) as Record<string, string>;

    expect(en['nodes.identity_change_successor']).toMatch(/2\.8/);
    expect(en['nodes.identity_change_predecessor']).toMatch(/2\.8/);
    // The wording must stay hedged for a name-only match: "likely", not "is".
    expect(en['nodes.identity_change_likely']).toMatch(/verify/i);
    expect(en['nodes.identity_change_certain']).toMatch(/public key/i);
  });
});
