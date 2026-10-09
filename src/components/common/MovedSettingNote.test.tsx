/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MovedSettingNote } from './MovedSettingNote';

vi.mock('../../contexts/IconStyleContext', () => ({ useIconStyleOptional: () => 'lucide' }));

describe('MovedSettingNote (#5683 follow-up)', () => {
  it('shows the sentence and a router link to the new place, on the old anchor', () => {
    render(
      <MemoryRouter>
        <MovedSettingNote id="old-anchor" testId="note" text="X moved to Y." linkLabel="Open Y" to="/source/a/configuration#config-x" />
      </MemoryRouter>,
    );
    const note = screen.getByTestId('note');
    expect(note.id).toBe('old-anchor');
    expect(note).toHaveTextContent('X moved to Y.');
    expect(screen.getByRole('link', { name: 'Open Y' }).getAttribute('href')).toBe('/source/a/configuration#config-x');
  });

  it('uses a button for a page that switches views in state', () => {
    const onOpen = vi.fn();
    render(<MovedSettingNote text="X moved to Y." linkLabel="Open Y" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Y' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Open Y' })).toHaveAttribute('type', 'button');
  });

  it('shows the sentence alone when there is nowhere to send the viewer', () => {
    render(<MovedSettingNote text="X moved to Y." linkLabel="Open Y" />);
    expect(screen.getByText('X moved to Y.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to a plain anchor outside a router', () => {
    render(<MovedSettingNote text="X moved to Y." linkLabel="Open Y" to="/settings#settings-x" />);
    expect(screen.getByRole('link', { name: 'Open Y' }).getAttribute('href')).toBe('/settings#settings-x');
  });
});
