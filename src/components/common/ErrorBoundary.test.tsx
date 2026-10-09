/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';
import { AppErrorScreen } from './AppErrorScreen';

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

  it('renders a custom fallback with the thrown value, and retry re-renders the children', () => {
    let broken = true;
    const Flaky = () => {
      if (broken) throw new Error('first render fails');
      return <span>recovered</span>;
    };
    render(
      <ErrorBoundary fallback={(error, retry) => <button onClick={retry}>{`custom: ${(error as Error).message}`}</button>}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('Something went wrong')).toBeNull();
    broken = false;
    fireEvent.click(screen.getByText('custom: first render fails'));
    expect(screen.getByText('recovered')).toBeTruthy();
  });

  // The root boundary in main.tsx. A throw from an effect cleanup while a
  // subtree unmounts is reported ABOVE that subtree, so a boundary inside it
  // cannot help; without one further up React empties the root.
  it('as a root boundary it catches an unmount error from a removed subtree', () => {
    const BadCleanup = () => {
      React.useEffect(
        () => () => {
          throw new TypeError("Cannot read properties of undefined (reading 'remove')");
        },
        [],
      );
      return <span>page with a map</span>;
    };
    const tree = (showPage: boolean) => (
      <ErrorBoundary fallback={(error, retry) => <AppErrorScreen error={error} onRetry={retry} />}>
        {showPage ? (
          <ErrorBoundary fallbackTitle="inner">
            <BadCleanup />
          </ErrorBoundary>
        ) : (
          <span>next page</span>
        )}
      </ErrorBoundary>
    );
    const { rerender, container } = render(tree(true));
    rerender(tree(false));
    // Not a blank page: the recoverable screen, with the error named.
    expect(container.childElementCount).toBeGreaterThan(0);
    expect(screen.getByTestId('app-error-screen')).toBeTruthy();
    expect(screen.getByText("Cannot read properties of undefined (reading 'remove')")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'app_error.retry' }));
    expect(screen.getByText('next page')).toBeTruthy();
  });
});
