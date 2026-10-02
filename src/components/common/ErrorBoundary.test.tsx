/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn() } }));

function Thrower({ value }: { value: unknown }): never {
  throw value;
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // React logs caught render errors; keep the test output clean.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it('shows the message of a thrown Error', () => {
    render(
      <ErrorBoundary>
        <Thrower value={new Error('boom')} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('shows a thrown string instead of a blank box (#5516)', () => {
    render(
      <ErrorBoundary>
        <Thrower value="Map has no maxZoom specified" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Map has no maxZoom specified')).toBeTruthy();
  });
});
