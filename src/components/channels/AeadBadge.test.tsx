/**
 * @vitest-environment jsdom
 *
 * Read-only AEAD badge (#5248 Phase 1).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '../../../public/locales/en.json';
import AeadBadge from './AeadBadge';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string) => (en as unknown as Record<string, string>)[key] ?? key;
  return createReactI18nextMock(t);
});

describe('AeadBadge (#5248)', () => {
  it('renders the badge with the tooltip when useAead is true', () => {
    render(<AeadBadge useAead />);
    const badge = screen.getByTestId('aead-badge');
    expect(badge.textContent).toContain('AEAD');
    expect(badge.getAttribute('title')).toBe(
      'This channel uses AES-CCM authenticated encryption. Only nodes with the same setting can read it.',
    );
  });

  it('renders nothing when useAead is false or missing', () => {
    const { container, rerender } = render(<AeadBadge useAead={false} />);
    expect(container.innerHTML).toBe('');
    rerender(<AeadBadge />);
    expect(container.innerHTML).toBe('');
  });
});
