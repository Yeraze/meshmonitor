/**
 * Node Details note for the aircraft override (#5715): tells a person's mark
 * ("Marked as not aircraft by you on …") apart from the age-out sweep's
 * automatic fixed mark ("Reclassified as fixed"). Renders nothing when the
 * node carries neither.
 */
import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../types/device';
import { AuthContext } from '../contexts/AuthContext';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import { normalizeAircraftManualMark } from '../utils/aircraftClassification';
import { UiIcon } from './icons';

interface Props {
  node: Pick<DeviceInfo, 'aircraftManualMark' | 'aircraftManualMarkAt' | 'aircraftManualMarkBy' | 'aircraftFixedAt'>;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

const AircraftMarkNote: React.FC<Props> = ({ node, timeFormat, dateFormat }) => {
  const { t } = useTranslation();
  // Read the context directly: Node Details also renders outside an AuthProvider.
  const myId = useContext(AuthContext)?.authStatus?.user?.id ?? null;
  const mark = normalizeAircraftManualMark(node.aircraftManualMark);

  if (mark) {
    const at = node.aircraftManualMarkAt;
    const date = typeof at === 'number' ? formatDateTime(new Date(at), timeFormat, dateFormat) : null;
    const byMe = myId !== null && node.aircraftManualMarkBy === myId;
    const label = mark === 'not_aircraft'
      ? t('aircraft_mark.note_not_aircraft', 'Marked as not aircraft')
      : t('aircraft_mark.note_aircraft', 'Marked as aircraft');
    let who: string;
    if (date) {
      who = byMe
        ? t('aircraft_mark.note_by_you_on', 'By you on {{date}}', { date })
        : t('aircraft_mark.note_by_user_on', 'By a user on {{date}}', { date });
    } else {
      who = byMe ? t('aircraft_mark.note_by_you', 'By you') : t('aircraft_mark.note_by_user', 'By a user');
    }
    const rule = mark === 'not_aircraft'
      ? t('aircraft_mark.note_not_aircraft_rule', 'Released if the node moves more than 1 km.')
      : t('aircraft_mark.note_aircraft_rule', 'Holds until cleared.');
    return (
      <div className="node-detail-card" data-testid="node-details-aircraft-manual">
        <div className="node-detail-label">
          <UiIcon name="aircraft" size={14} /> {label}
        </div>
        <div className="node-detail-value">{who}. {rule}</div>
      </div>
    );
  }

  if (node.aircraftFixedAt != null) {
    return (
      <div className="node-detail-card" data-testid="node-details-aircraft-fixed">
        <div className="node-detail-label">
          <UiIcon name="aircraft" size={14} /> {t('node_popup.aircraft_fixed', 'Reclassified as fixed')}
        </div>
        <div className="node-detail-value">
          {t('aircraft_mark.note_fixed_auto', 'Automatically, on {{date}}', {
            date: formatDateTime(new Date(node.aircraftFixedAt), timeFormat, dateFormat),
          })}
        </div>
      </div>
    );
  }
  return null;
};

export default AircraftMarkNote;
