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
 * @param format - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601)
 * @returns Formatted date string
 */
export function formatDate(date: Date, format: DateFormat = 'MM/DD/YYYY'): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();

  if (format === 'DD/MM/YYYY') {
    return `${day}/${month}/${year}`;
  } else if (format === 'YYYY-MM-DD') {
    return `${year}-${month}-${day}`;
  } else {
    return `${month}/${day}/${year}`;
  }
}

/**
 * Formats a complete date and time according to user preferences
 * @param date - Date object to format
 * @param timeFormat - '12' for 12-hour format, '24' for 24-hour format
 * @param dateFormat - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601)
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
 * @param dateFormat - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601)
 * @returns Formatted date and time string
 */
function formatTimestamp(
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
 * @param dateFormat - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601)
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

/**
 * Smart datetime formatting for messages based on how recent they are
 * - Today: just time (12:34 PM)
 * - Yesterday: "Yesterday 12:34 PM"
 * - This week: "Mon 12:34 PM"
 * - This year: "Nov 8 12:34 PM"
 * - Older: full date (11/08/2024 12:34 PM)
 *
 * @param date - Date object to format
 * @param timeFormat - '12' for 12-hour format, '24' for 24-hour format
 * @param dateFormat - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601) (used for older dates)
 * @returns Smart formatted datetime string
 */
export function formatMessageTime(
  date: Date,
  timeFormat: TimeFormat = '24',
  dateFormat: DateFormat = 'MM/DD/YYYY'
): string {
  const now = new Date();
  const time = formatTime(date, timeFormat);

  // Helper to check if two dates are on the same day
  const isSameDay = (d1: Date, d2: Date) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();

  // Today - just show time
  if (isSameDay(date, now)) {
    return time;
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return `Yesterday ${time}`;
  }

  // This week (within last 7 days)
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 7) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = dayNames[date.getDay()];
    return `${dayName} ${time}`;
  }

  // This year - show month and day
  if (date.getFullYear() === now.getFullYear()) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = monthNames[date.getMonth()];
    const day = date.getDate();
    return `${monthName} ${day} ${time}`;
  }

  // Older - show full date
  return `${formatDate(date, dateFormat)} ${time}`;
}

/**
 * Get the date string for a message (for date separators)
 * @param date - Date object
 * @param _dateFormat - 'MM/DD/YYYY', 'DD/MM/YYYY', or 'YYYY-MM-DD' (ISO 8601) (reserved for future use)
 * @returns Formatted date string for separator
 */
export function getMessageDateSeparator(
  date: Date,
  _dateFormat: DateFormat = 'MM/DD/YYYY'
): string {
  const now = new Date();

  // Helper to check if two dates are on the same day
  const isSameDay = (d1: Date, d2: Date) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();

  // Today
  if (isSameDay(date, now)) {
    return 'Today';
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return 'Yesterday';
  }

  // This year - show full date without year
  if (date.getFullYear() === now.getFullYear()) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    return `${monthNames[date.getMonth()]} ${date.getDate()}`;
  }

  // Older - show full date with year
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  return `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * Check if a date separator should be shown between two messages
 * @param prevDate - Previous message date (or null if first message)
 * @param currentDate - Current message date
 * @returns true if a separator should be shown
 */
export function shouldShowDateSeparator(
  prevDate: Date | null,
  currentDate: Date
): boolean {
  if (!prevDate) return true;

  return prevDate.getFullYear() !== currentDate.getFullYear() ||
         prevDate.getMonth() !== currentDate.getMonth() ||
         prevDate.getDate() !== currentDate.getDate();
}
