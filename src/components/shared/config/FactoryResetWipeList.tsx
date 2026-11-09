/**
 * FactoryResetWipeList — "this wipes" list for a factory-reset dialog
 * (P8a #6257, S6). Meshtastic and MeshCore pass the lines that apply to
 * their device; the heading reuses the `device_actions.reset_wipes_*` copy.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

export type FactoryResetWipeItem =
  | 'settings'
  | 'channels'
  | 'nodedb'
  | 'network'
  | 'identity'
  | 'contacts';

const ITEM_KEYS: Record<FactoryResetWipeItem, string> = {
  settings: 'device_actions.reset_wipes_settings',
  channels: 'device_actions.reset_wipes_channels',
  nodedb: 'device_actions.reset_wipes_nodedb',
  network: 'device_actions.reset_wipes_network',
  identity: 'device_actions.reset_wipes_identity',
  contacts: 'meshcore.factory_reset.wipes_contacts',
};

export interface FactoryResetWipeListProps {
  items: readonly FactoryResetWipeItem[];
  /** Replaces the default line for an item (a device-specific wording). */
  labels?: Partial<Record<FactoryResetWipeItem, string>>;
}

export const FactoryResetWipeList: React.FC<FactoryResetWipeListProps> = ({ items, labels }) => {
  const { t } = useTranslation();
  return (
    <>
      <p>{t('device_actions.reset_wipes_heading')}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>{labels?.[item] ?? t(ITEM_KEYS[item])}</li>
        ))}
      </ul>
    </>
  );
};

export default FactoryResetWipeList;
