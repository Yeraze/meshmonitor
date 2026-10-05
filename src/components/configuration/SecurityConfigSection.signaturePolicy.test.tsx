/**
 * @vitest-environment jsdom
 *
 * #5612: the local Security section asks before a packet signature policy
 * change goes out. Balanced: a plain confirm. Strict: the node's short name
 * typed out. Back to Compatible, or no change: nothing.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PacketSignaturePolicy } from '../../utils/packetSignaturePolicy';

interface SaveBarOptions {
  hasChanges: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
}

const h = vi.hoisted(() => ({ saveBar: null as unknown }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    h.saveBar = options;
  },
}));

import SecurityConfigSection from './SecurityConfigSection';

const { COMPATIBLE, BALANCED, STRICT } = PacketSignaturePolicy;
const saveBar = () => h.saveBar as SaveBarOptions;

function Harness({ loaded, onSave }: { loaded: number | null; onSave: (policy: number | null) => Promise<void> }) {
  const [policy, setPolicy] = useState<number | null>(loaded);
  const [adminKeys, setAdminKeys] = useState<string[]>(['']);
  const [isManaged, setIsManaged] = useState(false);
  return (
    <SecurityConfigSection
      publicKey="PUB"
      privateKey="PRIV"
      adminKeys={adminKeys}
      isManaged={isManaged}
      serialEnabled={false}
      debugLogApiEnabled={false}
      adminChannelEnabled={false}
      setAdminKeys={setAdminKeys}
      setIsManaged={setIsManaged}
      setSerialEnabled={vi.fn()}
      setDebugLogApiEnabled={vi.fn()}
      setAdminChannelEnabled={vi.fn()}
      packetSignaturePolicy={policy}
      setPacketSignaturePolicy={setPolicy}
      loadedPacketSignaturePolicy={loaded}
      firmwareVersion="2.8.0.abcdef0"
      nodeShortName="BASE"
      nodeLabel="Base Station"
      isSaving={false}
      onSave={() => onSave(policy)}
    />
  );
}

function setup(loaded: number | null = COMPATIBLE) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<Harness loaded={loaded} onSave={onSave} />);
  return { onSave, user: userEvent.setup(), select: screen.getByRole('combobox') as HTMLSelectElement };
}

/** Start a save the way the SaveBar does; it stays pending while a dialog is open. */
function startSave(): Promise<void> {
  let done!: Promise<void>;
  act(() => {
    done = saveBar().onSave();
  });
  return done;
}

beforeEach(() => {
  h.saveBar = null;
});

describe('SecurityConfigSection packet signature policy (#5612)', () => {
  it('shows the node\'s policy and counts a new pick as an unsaved change', async () => {
    const { user, select } = setup(BALANCED);
    expect(select.value).toBe(String(BALANCED));
    expect(saveBar().hasChanges).toBe(false);

    await user.selectOptions(select, String(STRICT));

    expect(saveBar().hasChanges).toBe(true);
  });

  it('saves with no dialog when the policy is unchanged', async () => {
    const { onSave, user } = setup(STRICT);
    await user.click(screen.getByLabelText(/security_config\.is_managed/));

    await act(async () => {
      await saveBar().onSave();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('going back to Compatible needs no confirm', async () => {
    const { onSave, user, select } = setup(STRICT);
    await user.selectOptions(select, String(COMPATIBLE));

    await act(async () => {
      await saveBar().onSave();
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith(COMPATIBLE);
  });

  it('Balanced asks a plain confirm: no word to type', async () => {
    const { onSave, user, select } = setup(COMPATIBLE);
    await user.selectOptions(select, String(BALANCED));

    const saving = startSave();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('signature_policy.confirm_balanced_title');
    expect(screen.queryByRole('textbox', { name: /typed_confirm\.prompt/ })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'signature_policy.confirm_balanced_button' }));
    await act(async () => {
      await saving;
    });

    expect(onSave).toHaveBeenCalledWith(BALANCED);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Strict stays locked until the node\'s short name is typed', async () => {
    const { onSave, user, select } = setup(COMPATIBLE);
    await user.selectOptions(select, String(STRICT));

    const saving = startSave();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('signature_policy.confirm_strict_title');
    expect(dialog).toHaveTextContent('signature_policy.confirm_strict_cutoff');
    const confirm = screen.getByRole('button', { name: 'signature_policy.confirm_strict_button' });
    expect(confirm).toBeDisabled();

    const input = screen.getByRole('textbox', { name: /typed_confirm\.prompt/ });
    await user.type(input, 'BAS');
    expect(confirm).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(input, 'E');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await act(async () => {
      await saving;
    });

    expect(onSave).toHaveBeenCalledWith(STRICT);
  });

  it('cancelling the confirm sends nothing and keeps the change pending', async () => {
    const { onSave, user, select } = setup(COMPATIBLE);
    await user.selectOptions(select, String(STRICT));

    const saving = startSave();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'common.cancel' }));
    await act(async () => {
      await saving;
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(saveBar().hasChanges).toBe(true);
    expect(select.value).toBe(String(STRICT));
  });

  it('declining the policy confirm after accepting a private-key change sends nothing', async () => {
    const VALID_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSave = vi.fn().mockResolvedValue(undefined);
    function KeyHarness() {
      const [policy, setPolicy] = useState<number | null>(COMPATIBLE);
      const [privateKey, setPrivateKey] = useState('PRIV');
      return (
        <SecurityConfigSection
          publicKey="PUB"
          privateKey={privateKey}
          setPrivateKey={setPrivateKey}
          adminKeys={['']}
          isManaged={false}
          serialEnabled={false}
          debugLogApiEnabled={false}
          adminChannelEnabled={false}
          setAdminKeys={vi.fn()}
          setIsManaged={vi.fn()}
          setSerialEnabled={vi.fn()}
          setDebugLogApiEnabled={vi.fn()}
          setAdminChannelEnabled={vi.fn()}
          packetSignaturePolicy={policy}
          setPacketSignaturePolicy={setPolicy}
          loadedPacketSignaturePolicy={COMPATIBLE}
          firmwareVersion="2.8.0.abcdef0"
          nodeShortName="BASE"
          nodeLabel="Base Station"
          isSaving={false}
          onSave={onSave}
        />
      );
    }
    render(<KeyHarness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /security_config\.set_private_key/ }));
    await user.type(screen.getByLabelText(/security_config\.private_key/), VALID_KEY);
    await user.selectOptions(screen.getByRole('combobox'), String(BALANCED));

    const saving = startSave();
    const dialog = await screen.findByRole('dialog');
    expect(confirmSpy).toHaveBeenCalledWith('security_config.set_private_key_confirm');
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    await act(async () => {
      await saving;
    });

    // One packet carries both changes, so neither went out.
    expect(onSave).not.toHaveBeenCalled();
    expect(saveBar().hasChanges).toBe(true);
    confirmSpy.mockRestore();
  });

  it('asks again on the next save when the first one did not reach the node', async () => {
    // The parent moves the loaded policy only after a save that worked. Here
    // it never does, so the change is still pending and must be confirmed again.
    const { onSave, user, select } = setup(COMPATIBLE);
    await user.selectOptions(select, String(BALANCED));

    for (let attempt = 1; attempt <= 2; attempt++) {
      const saving = startSave();
      await user.click(await screen.findByRole('button', { name: 'signature_policy.confirm_balanced_button' }));
      await act(async () => {
        await saving;
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(onSave).toHaveBeenCalledTimes(attempt);
    }
  });

  it('dismissing the save bar puts the node\'s policy back', async () => {
    const { user, select } = setup(BALANCED);
    await user.selectOptions(select, String(STRICT));

    act(() => saveBar().onDismiss());

    expect(select.value).toBe(String(BALANCED));
    expect(saveBar().hasChanges).toBe(false);
  });

  it('an unknown policy stays disabled and is not a change', () => {
    const { select } = setup(null);
    expect(select).toBeDisabled();
    expect(saveBar().hasChanges).toBe(false);
  });
});
