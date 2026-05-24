/**
 * @vitest-environment jsdom
 *
 * Sort behavior for the MeshCore Nodes list. Verifies the user can switch
 * between "last heard" (default, recency-first) and alphabetical name
 * sorting, and flip direction.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: () => <div data-testid="mc-map" />,
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';
import type { MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

const nodes: MeshCoreNode[] = [
  { publicKey: PK_A, name: 'Charlie', advType: 1, lastHeard: 1000 },
  { publicKey: PK_B, name: 'alpha', advType: 1, lastHeard: 3000 },
  { publicKey: PK_C, name: 'Bravo', advType: 1, lastHeard: 2000 },
];

const contacts: MeshCoreContact[] = [];

function listedNames(): string[] {
  // The first span inside `.mc-node-row-name` is the display name; the
  // second (when present) is the device-type label.
  const rows = Array.from(document.querySelectorAll('.mc-node-row .mc-node-row-name'));
  return rows.map((el) => el.querySelector('span')?.textContent || '');
}

describe('MeshCoreNodesView — sort controls', () => {
  it('defaults to sorting by last heard, descending (most recent first)', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    // lastHeard order desc: alpha(3000) -> Bravo(2000) -> Charlie(1000)
    expect(listedNames()).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('sorts alphabetically (case-insensitive) when "Name" is selected', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // Direction defaults to desc — toggle to asc for natural alphabetical.
    fireEvent.click(screen.getByTitle('Descending'));
    expect(listedNames()).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('reverses order when the direction button is clicked', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    const dropdown = screen.getByTitle('Sort by') as HTMLSelectElement;
    fireEvent.change(dropdown, { target: { value: 'name' } });
    // After selecting name, direction is still 'desc' from default — Z..A.
    expect(listedNames()).toEqual(['Charlie', 'Bravo', 'alpha']);
  });
});
