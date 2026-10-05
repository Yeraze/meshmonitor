/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PacketSignaturePolicyPicker, type PacketSignaturePolicyPickerProps } from './PacketSignaturePolicyPicker';
import { PacketSignaturePolicy } from '../../utils/packetSignaturePolicy';

const { COMPATIBLE, BALANCED, STRICT } = PacketSignaturePolicy;

function setup(props: Partial<PacketSignaturePolicyPickerProps> = {}) {
  const onChange = vi.fn();
  render(
    <PacketSignaturePolicyPicker
      loadedPolicy={COMPATIBLE}
      value={COMPATIBLE}
      onChange={onChange}
      firmwareVersion="2.8.0.abcdef0"
      {...props}
    />,
  );
  return { onChange, select: screen.getByRole('combobox') as HTMLSelectElement };
}

describe('PacketSignaturePolicyPicker', () => {
  it('offers all three values on firmware 2.8.0+ and shows the node\'s own', () => {
    const { select } = setup({ loadedPolicy: BALANCED, value: BALANCED });

    expect(select).toBeEnabled();
    expect(select.value).toBe(String(BALANCED));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['0', '1', '2']);
    expect(screen.queryByTestId('signature-policy-reason')).not.toBeInTheDocument();
  });

  it('never calls Balanced "recommended"', () => {
    setup({ loadedPolicy: BALANCED, value: BALANCED });
    expect(document.body.textContent).not.toMatch(/recommend/i);
  });

  it('reports the chosen value', async () => {
    const user = userEvent.setup();
    const { onChange, select } = setup();

    await user.selectOptions(select, String(STRICT));

    expect(onChange).toHaveBeenCalledWith(STRICT);
  });

  describe('firmware gate', () => {
    it('is disabled below 2.8.0, with the reason and the node\'s version', () => {
      const { select } = setup({ firmwareVersion: '2.7.15.567b8ea' });

      expect(select).toBeDisabled();
      const reason = screen.getByTestId('signature-policy-reason');
      expect(reason).toHaveTextContent('signature_policy.reason_firmware_too_old');
      expect(select).toHaveAccessibleDescription(/reason_firmware_too_old/);
    });

    it.each([[null], [undefined], ['Unknown'], ['']])('is disabled when the firmware version is %j', (firmwareVersion) => {
      const { select } = setup({ firmwareVersion });

      expect(select).toBeDisabled();
      expect(screen.getByTestId('signature-policy-reason')).toHaveTextContent('signature_policy.reason_firmware_unknown');
    });

    it('does not show Compatible as the value of a node it cannot change', () => {
      const { select } = setup({ firmwareVersion: '2.7.15' });

      expect(select.value).toBe('');
      expect(select.selectedOptions[0]).toHaveTextContent('signature_policy.option_unknown');
    });
  });

  describe('unknown policy', () => {
    it.each([[null], [7]])('a loaded policy of %j shows "unknown" and stays disabled', (loadedPolicy) => {
      const { select } = setup({ loadedPolicy, value: null });

      expect(select).toBeDisabled();
      expect(select.value).toBe('');
      expect(select.selectedOptions[0]).toHaveTextContent('signature_policy.option_unknown');
      expect(screen.getByTestId('signature-policy-reason')).toHaveTextContent('signature_policy.reason_policy_unknown');
    });

    it('does not fall back to Compatible when the form holds a stale value', () => {
      // The node could not be read, but the form still holds 0 from before.
      const { select } = setup({ loadedPolicy: null, value: COMPATIBLE });

      expect(select).toBeDisabled();
      expect(select.value).toBe('');
    });
  });

  describe('warnings next to the control', () => {
    it('shows none on Compatible', () => {
      setup();
      expect(screen.queryByTestId('signature-policy-strict-warning')).not.toBeInTheDocument();
      expect(screen.queryByTestId('signature-policy-balanced-warning')).not.toBeInTheDocument();
    });

    it('says what Strict drops and that it can cut the node off from older peers', () => {
      setup({ value: STRICT });

      const warning = screen.getByTestId('signature-policy-strict-warning');
      expect(warning).toHaveTextContent('signature_policy.strict_warning_title');
      expect(warning).toHaveTextContent('signature_policy.strict_drops_old_peers');
      expect(warning).toHaveTextContent('signature_policy.strict_drops_unicasts');
      expect(warning).toHaveTextContent('signature_policy.strict_drops_large_broadcasts');
      expect(warning).toHaveTextContent('signature_policy.strict_warning_relay');
    });

    it('shows the Balanced warning on Balanced only', () => {
      setup({ value: BALANCED });
      expect(screen.getByTestId('signature-policy-balanced-warning')).toHaveTextContent('signature_policy.balanced_warning');
      expect(screen.queryByTestId('signature-policy-strict-warning')).not.toBeInTheDocument();
    });

    it('shows no warning for a control that is locked', () => {
      setup({ value: STRICT, firmwareVersion: '2.7.15' });
      expect(screen.queryByTestId('signature-policy-strict-warning')).not.toBeInTheDocument();
    });
  });

  it('honors the caller\'s own disable', () => {
    const { select } = setup({ disabled: true });
    expect(select).toBeDisabled();
    // Still the node's value: this is a busy state, not an unknown one.
    expect(select.value).toBe(String(COMPATIBLE));
  });
});
