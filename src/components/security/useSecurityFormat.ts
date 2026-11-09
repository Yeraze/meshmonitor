import { useTranslation } from 'react-i18next';
import { isClockNotSet } from '../../utils/securityClock';

/** The date, relative-time and clock-offset formatters the Security tab sections share. */
export function useSecurityFormat() {
  const { t } = useTranslation();

  const formatDate = (timestamp: number | null | undefined) => {
    if (!timestamp) return t('security.never');
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatRelativeTime = (timestamp: number | null | undefined) => {
    if (!timestamp) return t('security.never');
    const diff = Date.now() / 1000 - timestamp;
    if (diff < 60) return t('security.just_now');
    if (diff < 3600) return t('security.minutes_ago', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('security.hours_ago', { count: Math.floor(diff / 3600) });
    return t('security.days_ago', { count: Math.floor(diff / 86400) });
  };

  const formatTimeOffset = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return t('security.unknown');
    // A clock that was never set is years off: say so instead of a drift in days.
    if (isClockNotSet(seconds)) return t('security.clock_not_set', 'Clock not set');
    const abs = Math.abs(Math.round(seconds));
    if (abs < 1) return t('security.offset_synchronized');

    const days = Math.floor(abs / 86400);
    const hours = Math.floor((abs % 86400) / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;

    const parts: string[] = [];
    if (days > 0) {
      parts.push(t('security.offset_days', { count: days }));
      if (hours > 0) parts.push(t('security.offset_hours', { count: hours }));
    } else if (hours > 0) {
      parts.push(t('security.offset_hours', { count: hours }));
      if (minutes > 0) parts.push(t('security.offset_minutes', { count: minutes }));
    } else if (minutes > 0) {
      parts.push(t('security.offset_minutes', { count: minutes }));
      if (secs > 0) parts.push(t('security.offset_seconds', { count: secs }));
    } else {
      parts.push(t('security.offset_seconds', { count: secs }));
    }

    const value = parts.join(', ');
    // Convention: positive timeOffsetSeconds = node behind server, negative = ahead
    return seconds >= 0
      ? t('security.offset_behind', { value })
      : t('security.offset_ahead', { value });
  };

  return { formatDate, formatRelativeTime, formatTimeOffset };
}
