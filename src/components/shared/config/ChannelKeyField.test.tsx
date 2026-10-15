/**
 * @vitest-environment jsdom
 *
 * ChannelKeyField (#5829): mask, show, copy, generate, format, validity and
 * the read-only (derived) lock.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChannelKeyField, type ChannelKeyFieldProps } from './ChannelKeyField';
import { channelKeyByteLength, isValidChannelKey } from './channelKey';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

const Harness: React.FC<Partial<ChannelKeyFieldProps> & { initial?: string }> = ({ initial = '', ...props }) => {
  const [value, setValue] = useState(initial);
  return (
    <ChannelKeyField
      id="key"
      label="Key"
      format="base64"
      generateBytes={32}
      {...props}
      value={value}
      onChange={setValue}
    />
  );
};

const input = () => screen.getByLabelText('Key') as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ChannelKeyField', () => {
  it('is masked by default and Show / Hide toggles it', () => {
    render(<Harness initial="AQ==" />);
    expect(input().type).toBe('password');
    fireEvent.click(button('Show'));
    expect(input().type).toBe('text');
    expect(button('Hide').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('Hide'));
    expect(input().type).toBe('password');
  });

  it('copies the key and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Harness initial="AQ==" />);
    fireEvent.click(button('Copy'));
    await waitFor(() => expect(button('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('AQ==');
  });

  it('turns Copy off for an empty key', () => {
    render(<Harness />);
    expect(button('Copy').disabled).toBe(true);
  });

  it('generates a base64 key of the requested length', () => {
    render(<Harness generateBytes={32} />);
    fireEvent.click(button('Generate'));
    expect(channelKeyByteLength(input().value, 'base64')).toBe(32);
  });

  it('generates a hex key of the requested length', () => {
    render(<Harness format="hex" generateBytes={16} />);
    fireEvent.click(button('Generate'));
    expect(input().value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('flags a key whose length is not allowed', () => {
    render(<Harness initial="AAAA" allowedBytes={[0, 1, 16, 32]} invalidMessage="Bad key" />);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Bad key');
    fireEvent.change(input(), { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('read-only locks the field and Generate and shows the hint', () => {
    render(<Harness initial="00" format="hex" readOnly hint="Derived from the name" />);
    expect(input().readOnly).toBe(true);
    expect(button('Generate').disabled).toBe(true);
    expect(screen.getByText('Derived from the name')).toBeTruthy();
  });
});

describe('channelKey helpers', () => {
  it('reads base64 and hex lengths', () => {
    expect(channelKeyByteLength('', 'base64')).toBe(0);
    expect(channelKeyByteLength('AQ==', 'base64')).toBe(1);
    expect(channelKeyByteLength('not base64!', 'base64')).toBeNull();
    expect(channelKeyByteLength('0a0b', 'hex')).toBe(2);
    expect(channelKeyByteLength('0a0', 'hex')).toBeNull();
    expect(isValidChannelKey('AA==', 'base64', [0, 1, 16, 32])).toBe(true);
    expect(isValidChannelKey('AAAA', 'base64', [0, 1, 16, 32])).toBe(false);
  });
});
