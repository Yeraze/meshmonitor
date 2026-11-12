/**
 * @vitest-environment jsdom
 *
 * ConnectionErrorPanel (#4173 review N10) — extracted from App.tsx; the
 * handlers must still reach the buttons they came from.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ConnectionErrorPanel from './ConnectionErrorPanel';

afterEach(cleanup);

describe('ConnectionErrorPanel', () => {
  it('shows the error and keeps the global error-panel classes', () => {
    render(<ConnectionErrorPanel error="Cannot connect" onRetry={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    expect(screen.getByText('Cannot connect')).toBeInTheDocument();
    expect(document.querySelector('.error-panel .error-actions')).not.toBeNull();
  });

  it('fires Retry and Dismiss', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<ConnectionErrorPanel error="x" onRetry={onRetry} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Retry Connection'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
