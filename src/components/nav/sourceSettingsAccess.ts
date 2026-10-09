/**
 * Who may open a source's Settings page (#5683 follow-up).
 *
 * One rule, read by the nav (`Sidebar`), its footer link and App's tab guard,
 * so an entry the nav shows is a page App will render.
 *
 *   any source   `settings:read` on any source. The page's routes are mostly
 *                unscoped, so this mirrors the server's union check (#4416).
 *   MQTT bridge  also `sources:read`. The bridge's setup used to be a page of
 *                its own behind that grant; it is a section of Settings now.
 *                A viewer holding only `sources:read` sees that one section
 *                (see the `settings` route in App.tsx), so nobody lost the
 *                page when its nav entry went away.
 *
 * Hiding a page is not the access control: each section's routes check their
 * own grant, and each section gates its controls on that grant.
 */
import type { ResourceType } from '../../types/permission';

type HasPermission = (
  resource: ResourceType,
  action: 'read' | 'write',
  options?: { anySource?: boolean },
) => boolean;

export function canOpenSourceSettings(
  hasPermission: HasPermission,
  sourceType: string | null | undefined,
): boolean {
  if (hasPermission('settings', 'read', { anySource: true })) return true;
  return sourceType === 'mqtt_bridge' && hasPermission('sources', 'read');
}
