/**
 * Shared severity -> icon/label/rank mappings used across the mesh-issues
 * dashboard (#4964 report reorganization, WP4). One home for constants every
 * summary/section/table component needs, so no two copies drift out of step.
 */
import type { UiIconName } from '../../icons';
import type { MeshIssueSeverity } from '../meshIssueTypes';

export const SEVERITY_ICON: Record<MeshIssueSeverity, UiIconName> = {
  critical: 'error',
  warning: 'alert',
  info: 'info',
};

export const SEVERITY_LABEL: Record<MeshIssueSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

/** Lower rank = worse. Mirrors `grouping.ts`'s internal (unexported)
 *  `SEVERITY_RANK` — used here for the table's severity column sort. */
export const SEVERITY_RANK: Record<MeshIssueSeverity, number> = { critical: 0, warning: 1, info: 2 };
