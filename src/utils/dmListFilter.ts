import type { DmFilter } from '../types/ui.js';

export interface DmFilterSubject {
  unread: boolean;
  /** Last message time in ms. */
  lastMessageTime: number;
  isFavorite: boolean;
  hasPosition: boolean;
  isInfrastructure: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a DM conversation passes the chosen filter. 'hops' and 'all' pass. */
export function passesDmFilter(s: DmFilterSubject, filter: DmFilter, nowMs: number = Date.now()): boolean {
  switch (filter) {
    case 'unread':
      return s.unread;
    case 'recent':
      return s.lastMessageTime > nowMs - DAY_MS;
    case 'favorites':
      return s.isFavorite;
    case 'withPosition':
      return s.hasPosition;
    case 'noInfra':
      return !s.isInfrastructure;
    case 'hops':
    case 'all':
    default:
      return true;
  }
}
