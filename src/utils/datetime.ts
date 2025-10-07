import { TimeFormat, DateFormat } from '../contexts/SettingsContext';

/**
 * Formats a time according to the user's preferred time format
 * @param date - Date object to format
 * @param format - '12' for 12-hour format, '24' for 24-hour format
 * @returns Formatted time string
 */
export function formatTime(date: Date, format: TimeFormat = '24'): string {
  if (format === '12') {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } else {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
}

/**
 * Formats a date according to the user's preferred date format
 * @param date - Date object to format
 * @param format - 'MM/DD/YYYY' or 'DD/MM/YYYY'
 * @returns Formatted date string
 */
export function formatDate(date: Date, format: DateFormat = 'MM/DD/YYYY'): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();

  if (format === 'DD/MM/YYYY') {
    return `${day}/${month}/${year}`;
  } else {
    return `${month}/${day}/${year}`;
  }
}

/**
 * Formats a complete date and time according to user preferences
 * @param date - Date object to format
 * @param timeFormat - '12' for 12-hour format, '24' for 24-hour format
 * @param dateFormat - 'MM/DD/YYYY' or 'DD/MM/YYYY'
 * @returns Formatted date and time string
 */
export function formatDateTime(
  date: Date,
  timeFormat: TimeFormat = '24',
  dateFormat: DateFormat = 'MM/DD/YYYY'
): string {
  return `${formatDate(date, dateFormat)} ${formatTime(date, timeFormat)}`;
}

/**
 * Formats a timestamp (milliseconds since epoch) according to user preferences
 * @param timestamp - Timestamp in milliseconds
 * @param timeFormat - '12' for 12-hour format, '24' for 24-hour format
 * @param dateFormat - 'MM/DD/YYYY' or 'DD/MM/YYYY'
 * @returns Formatted date and time string
 */
export function formatTimestamp(
  timestamp: number,
  timeFormat: TimeFormat = '24',
  dateFormat: DateFormat = 'MM/DD/YYYY'
): string {
  const date = new Date(timestamp);
  return formatDateTime(date, timeFormat, dateFormat);
}

/**
 * Formats a relative time (e.g., "5 minutes ago") with optional absolute time
 * @param timestamp - Timestamp in milliseconds
 * @param timeFormat - '12' for 12-hour format, '24' for 24-hour format
 * @param dateFormat - 'MM/DD/YYYY' or 'DD/MM/YYYY'
 * @param showAbsolute - Whether to include absolute time in parentheses
 * @returns Formatted relative time string
 */
export function formatRelativeTime(
  timestamp: number,
  timeFormat: TimeFormat = '24',
  dateFormat: DateFormat = 'MM/DD/YYYY',
  showAbsolute: boolean = false
): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  let relative: string;
  if (diffSec < 60) {
    relative = 'just now';
  } else if (diffMin < 60) {
    relative = `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  } else if (diffHour < 24) {
    relative = `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
  } else if (diffDay < 7) {
    relative = `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  } else {
    // For older dates, just show the absolute date
    return formatTimestamp(timestamp, timeFormat, dateFormat);
  }

  if (showAbsolute) {
    const absolute = formatTimestamp(timestamp, timeFormat, dateFormat);
    return `${relative} (${absolute})`;
  }

  return relative;
}
