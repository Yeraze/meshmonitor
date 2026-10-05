/**
 * @vitest-environment jsdom
 *
 * TAK team + role section (#5613): the two pickers, their options, the
 * TAK_TRACKER and reboot notes, and the firmware gate.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAK_ROLE_OPTIONS, TAK_TEAM_OPTIONS } from '../../utils/takConfig';

// The default `t` here returns a fallback when the component passes one (the
// option labels) and the key otherwise.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({ saveBar: vi.fn() }));
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: h.saveBar }));

import TAKConfigSection from './TAKConfigSection';
import TAKConfigFields from './TAKConfigFields';

function setup(props: Partial<React.ComponentProps<typeof TAKConfigSection>> = {}) {
  const setTeam = vi.fn();
  const setRole = vi.fn();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <TAKConfigSection
      team={0}
      setTeam={setTeam}
      role={0}
      setRole={setRole}
      isDisabled={false}
      isSaving={false}
      onSave={onSave}
      {...props}
    />,
  );
  return { setTeam, setRole, onSave, user: userEvent.setup(), ...utils };
}

const teamSelect = () => screen.getByLabelText(/tak_config\.team/) as HTMLSelectElement;
const roleSelect = () => screen.getByLabelText(/tak_config\.role/) as HTMLSelectElement;
const lastSaveBar = () => h.saveBar.mock.calls.at(-1)![0];

describe('TAKConfigSection', () => {
  beforeEach(() => h.saveBar.mockClear());

  it('offers every Team and MemberRole from the protobufs, by value', () => {
    setup();
    expect(within(teamSelect()).getAllByRole('option').map((o) => Number((o as HTMLOptionElement).value)))
      .toEqual(TAK_TEAM_OPTIONS.map((o) => o.value));
    expect(within(roleSelect()).getAllByRole('option').map((o) => Number((o as HTMLOptionElement).value)))
      .toEqual(TAK_ROLE_OPTIONS.map((o) => o.value));
  });

  it('labels the options with the proto labels', () => {
    setup();
    expect(within(teamSelect()).getByRole('option', { name: 'Default (Cyan)' })).toBeInTheDocument();
    expect(within(teamSelect()).getByRole('option', { name: 'Dark Blue' })).toBeInTheDocument();
    expect(within(roleSelect()).getByRole('option', { name: 'Default (Team Member)' })).toBeInTheDocument();
    expect(within(roleSelect()).getByRole('option', { name: 'Forward Observer' })).toBeInTheDocument();
  });

  it('shows the current team and role', () => {
    setup({ team: 5, role: 2 });
    expect(teamSelect().value).toBe('5');
    expect(roleSelect().value).toBe('2');
  });

  it('says the settings only matter for device role TAK_TRACKER, and that a save reboots', () => {
    setup();
    expect(screen.getByTestId('takConfig-role-note')).toHaveTextContent('tak_config.tracker_only_note');
    expect(screen.getByTestId('takConfig-reboot-note')).toHaveTextContent('tak_config.reboot_note');
  });

  it('picking a team or role reports the number', async () => {
    const { setTeam, setRole, user } = setup();
    await user.selectOptions(teamSelect(), '12');
    await user.selectOptions(roleSelect(), '5');
    expect(setTeam).toHaveBeenCalledWith(12);
    expect(setRole).toHaveBeenCalledWith(5);
  });

  it('registers with the save bar, clean until a value changes', () => {
    const { rerender, setTeam, setRole, onSave } = setup({ team: 5, role: 2 });
    expect(lastSaveBar()).toMatchObject({ id: 'tak-config', hasChanges: false });

    rerender(
      <TAKConfigSection team={6} setTeam={setTeam} role={2} setRole={setRole} isDisabled={false} isSaving={false} onSave={onSave} />,
    );
    expect(lastSaveBar().hasChanges).toBe(true);
  });

  it('dismissing the save bar restores the loaded values', () => {
    const { rerender, setTeam, setRole, onSave } = setup({ team: 5, role: 2 });
    rerender(
      <TAKConfigSection team={6} setTeam={setTeam} role={3} setRole={setRole} isDisabled={false} isSaving={false} onSave={onSave} />,
    );
    lastSaveBar().onDismiss();
    expect(setTeam).toHaveBeenCalledWith(5);
    expect(setRole).toHaveBeenCalledWith(2);
  });

  it('the save bar save calls onSave', async () => {
    const { onSave } = setup({ team: 5, role: 2 });
    await lastSaveBar().onSave();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  describe('firmware older than 2.8.0', () => {
    it('shows the unsupported notice, disables both pickers and never reports changes', () => {
      const { rerender, setTeam, setRole, onSave } = setup({ isDisabled: true });
      expect(screen.getByTestId('tak-config-unsupported')).toHaveTextContent('tak_config.unsupported');
      expect(teamSelect()).toBeDisabled();
      expect(roleSelect()).toBeDisabled();

      rerender(
        <TAKConfigSection team={6} setTeam={setTeam} role={0} setRole={setRole} isDisabled isSaving={false} onSave={onSave} />,
      );
      expect(lastSaveBar().hasChanges).toBe(false);
    });

    it('shows no notice when supported', () => {
      setup();
      expect(screen.queryByTestId('tak-config-unsupported')).not.toBeInTheDocument();
    });
  });
});

describe('TAKConfigFields (shared with the Admin Commands section)', () => {
  it('reports changes by field name and uses its id prefix', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TAKConfigFields team={0} role={0} onChange={onChange} disabled={false} idPrefix="adminTak" />);

    expect(document.getElementById('adminTakTeam')).not.toBeNull();
    expect(document.getElementById('adminTakRole')).not.toBeNull();
    expect(screen.getByTestId('adminTak-role-note')).toBeInTheDocument();
    expect(screen.getByTestId('adminTak-reboot-note')).toBeInTheDocument();

    await user.selectOptions(document.getElementById('adminTakTeam') as HTMLSelectElement, '9');
    await user.selectOptions(document.getElementById('adminTakRole') as HTMLSelectElement, '8');
    expect(onChange).toHaveBeenCalledWith('team', 9);
    expect(onChange).toHaveBeenCalledWith('role', 8);
  });

  it('disabled locks both pickers', () => {
    render(<TAKConfigFields team={0} role={0} onChange={vi.fn()} disabled idPrefix="adminTak" />);
    expect(document.getElementById('adminTakTeam')).toBeDisabled();
    expect(document.getElementById('adminTakRole')).toBeDisabled();
  });
});
