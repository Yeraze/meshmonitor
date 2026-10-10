/**
 * @vitest-environment jsdom
 */
/**
 * Node Details note for the aircraft override (#5715): a person's mark reads
 * differently from the sweep's automatic fixed mark.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthContext } from '../contexts/AuthContext';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
import AircraftMarkNote from './AircraftMarkNote';

const AT = new Date(2026, 9, 9, 14, 30).getTime();

function renderNote(node: Parameters<typeof AircraftMarkNote>[0]['node'], myId: number | null = 7) {
  const value = { authStatus: myId === null ? null : { user: { id: myId } } } as any;
  return render(
    <AuthContext.Provider value={value}>
      <AircraftMarkNote node={node} timeFormat="24" dateFormat="YYYY-MM-DD" />
    </AuthContext.Provider>,
  );
}

describe('AircraftMarkNote', () => {
  it('a manual not-aircraft mark by me says "By you on …" and the release rule', () => {
    renderNote({ aircraftManualMark: 'not_aircraft', aircraftManualMarkAt: AT, aircraftManualMarkBy: 7, aircraftFixedAt: AT });
    const card = screen.getByTestId('node-details-aircraft-manual');
    expect(card.textContent).toContain('Marked as not aircraft');
    expect(card.textContent).toContain('By you on 2026-10-09');
    expect(card.textContent).toContain('more than 1 km');
    expect(screen.queryByTestId('node-details-aircraft-fixed')).toBeNull();
  });

  it("someone else's aircraft mark says \"By a user\" and that it holds", () => {
    renderNote({ aircraftManualMark: 'aircraft', aircraftManualMarkAt: AT, aircraftManualMarkBy: 3 });
    const card = screen.getByTestId('node-details-aircraft-manual');
    expect(card.textContent).toContain('Marked as aircraft');
    expect(card.textContent).toContain('By a user on 2026-10-09');
    expect(card.textContent).toContain('Holds until cleared');
  });

  it('the automatic fixed mark keeps the sweep wording', () => {
    renderNote({ aircraftFixedAt: AT });
    const card = screen.getByTestId('node-details-aircraft-fixed');
    expect(card.textContent).toContain('Reclassified as fixed');
    expect(card.textContent).toContain('Automatically');
    expect(screen.queryByTestId('node-details-aircraft-manual')).toBeNull();
  });

  it('renders nothing with no mark, and works with no AuthProvider', () => {
    const { container } = render(<AircraftMarkNote node={{}} />);
    expect(container.textContent).toBe('');
    render(<AircraftMarkNote node={{ aircraftManualMark: 'aircraft', aircraftManualMarkAt: AT, aircraftManualMarkBy: 7 }} />);
    expect(screen.getByTestId('node-details-aircraft-manual').textContent).toContain('By a user');
  });
});
