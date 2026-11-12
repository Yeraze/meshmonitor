/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PollErrorNotice from './PollErrorNotice';

describe('PollErrorNotice (#6342)', () => {
  it('shows a notice when the poll failed and the list is empty', () => {
    render(<PollErrorNotice error={new Error('Poll request failed: 500')} empty />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows nothing when the poll is fine', () => {
    const { container } = render(<PollErrorNotice error={null} empty />);
    expect(container.firstChild).toBeNull();
  });

  it('shows nothing when the list still holds data from an earlier read', () => {
    const { container } = render(<PollErrorNotice error={new Error('x')} empty={false} />);
    expect(container.firstChild).toBeNull();
  });
});
