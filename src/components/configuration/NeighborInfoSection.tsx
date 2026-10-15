import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { neighborInfoIntervalToSend } from '../../utils/broadcastIntervalFloor';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';

interface NeighborInfoSectionProps {
  /** False disables every control: no configuration:write on this source (#5830). */
  canWrite?: boolean;
  neighborInfoEnabled: boolean;
  neighborInfoInterval: number;
  neighborInfoTransmitOverLora: boolean;
  setNeighborInfoEnabled: (value: boolean) => void;
  setNeighborInfoInterval: (value: number) => void;
  setNeighborInfoTransmitOverLora: (value: boolean) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
  /** Bumped when the page reloads config from the node (#5797). */
  configVersion?: number;
}

const NeighborInfoSection: React.FC<NeighborInfoSectionProps> = ({
  canWrite = true,
  configVersion,
  neighborInfoEnabled,
  neighborInfoInterval,
  neighborInfoTransmitOverLora,
  setNeighborInfoEnabled,
  setNeighborInfoInterval,
  setNeighborInfoTransmitOverLora,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // What the node holds; moves on a successful save or a reload (#5797)
  const values = { neighborInfoEnabled, neighborInfoInterval, neighborInfoTransmitOverLora };
  const { baseline, hasChanges, commit } = useSectionBaseline(values, { reseedKey: configVersion });

  // Reset to saved values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setNeighborInfoEnabled(baseline.neighborInfoEnabled);
    setNeighborInfoInterval(baseline.neighborInfoInterval);
    setNeighborInfoTransmitOverLora(baseline.neighborInfoTransmitOverLora);
  }, [baseline, setNeighborInfoEnabled, setNeighborInfoInterval, setNeighborInfoTransmitOverLora]);

  // Move the baseline only when the node took the save, and record the
  // interval that was sent: the save raises it to the floor.
  const handleSave = async () => {
    if (await onSave()) {
      commit({ ...values, neighborInfoInterval: neighborInfoIntervalToSend(neighborInfoInterval) });
    }
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'neighbor-info',
    sectionName: t('neighbor_info.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canWrite} title={t('neighbor_info.title')} docsUrl="https://meshmonitor.org/features/device#neighbor-info" notice={<ModuleAvailabilityNotice />}>
      <div className="setting-item">
        <label htmlFor="neighborInfoEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="neighborInfoEnabled"
            type="checkbox"
            checked={neighborInfoEnabled}
            onChange={(e) => setNeighborInfoEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('neighbor_info.enable')}</div>
            <span className="setting-description">{t('neighbor_info.enable_description')}</span>
          </div>
        </label>
      </div>
      {neighborInfoEnabled && (
        <>
          <div className="setting-item">
            <label htmlFor="neighborInfoInterval">
              {t('neighbor_info.interval')}
              <span className="setting-description">{t('neighbor_info.interval_description')}</span>
            </label>
            <NumberInput
              id="neighborInfoInterval"
              min={14400}
              max={86400}
              integer
              value={neighborInfoInterval}
              onChange={setNeighborInfoInterval}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="neighborInfoTransmitOverLora" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="neighborInfoTransmitOverLora"
                type="checkbox"
                checked={neighborInfoTransmitOverLora}
                onChange={(e) => setNeighborInfoTransmitOverLora(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('neighbor_info.transmit_over_lora')}</div>
                <span className="setting-description">{t('neighbor_info.transmit_over_lora_description')}</span>
              </div>
            </label>
          </div>
        </>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default NeighborInfoSection;
