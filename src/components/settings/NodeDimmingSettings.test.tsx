/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodeDimmingSettings from './NodeDimmingSettings';
import { NODE_DIMMING_RANGES } from '../../constants/nodeDisplayDefaults';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

const base = {
  enabled: true,
  startHours: 1,
  minOpacity: 0.3,
  onEnabledChange: vi.fn(),
  onStartHoursChange: vi.fn(),
  onMinOpacityChange: vi.fn(),
};

describe('NodeDimmingSettings', () => {
  it('hides the inputs while disabled', () => {
    render(<NodeDimmingSettings {...base} enabled={false} />);
    expect(document.getElementById('nodeDimmingStartHours')).toBeNull();
    expect(document.getElementById('nodeDimmingMinOpacity')).toBeNull();
  });

  it('renders inputs with shared ranges and values when enabled', () => {
    render(<NodeDimmingSettings {...base} />);
    const start = document.getElementById('nodeDimmingStartHours') as HTMLInputElement;
    const op = document.getElementById('nodeDimmingMinOpacity') as HTMLInputElement;
    expect(start.value).toBe('1');
    expect(start.min).toBe(String(NODE_DIMMING_RANGES.nodeDimmingStartHours.min));
    expect(op.max).toBe(String(NODE_DIMMING_RANGES.nodeDimmingMinOpacity.max));
  });

  it('reports toggle changes', () => {
    const onEnabledChange = vi.fn();
    render(<NodeDimmingSettings {...base} onEnabledChange={onEnabledChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('uses a custom description when given and disables controls', () => {
    render(<NodeDimmingSettings {...base} disabled description="custom hint" />);
    expect(screen.getByText('custom hint')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById('nodeDimmingStartHours') as HTMLInputElement).disabled).toBe(true);
  });
});
