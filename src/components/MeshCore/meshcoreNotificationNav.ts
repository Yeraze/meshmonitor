/**
 * Where a notification click lands on the MeshCore page (#6253 P11 S10).
 *
 * The server sends `{type:'channel', channelId}` for channel messages and
 * `{type:'dm', senderNodeId}` for DMs and room posts (a room post carries the
 * room's key). A room key opens the Rooms view; any other key opens the DM.
 */
import type { NotificationNavigationData } from '../../utils/notificationUrl';
import { canonicalizePeerKey } from './meshcoreUnreadStore';

/** MeshCore advert type of a Room Server. */
const ADV_TYPE_ROOM = 3;

export type MeshCoreNotificationTarget =
  | { kind: 'channel'; channelIdx: number }
  | { kind: 'room'; publicKey: string }
  | { kind: 'dm'; publicKey: string }
  | { kind: 'none' };

export function resolveMeshCoreNotificationTarget(
  nav: NotificationNavigationData,
  contacts: ReadonlyArray<{ publicKey?: string; advType?: number | null }>,
): MeshCoreNotificationTarget {
  if (nav.type === 'channel') {
    return typeof nav.channelId === 'number' && nav.channelId >= 0
      ? { kind: 'channel', channelIdx: nav.channelId }
      : { kind: 'none' };
  }
  const raw = nav.senderNodeId;
  if (!raw) return { kind: 'none' };
  const publicKey = canonicalizePeerKey(raw, contacts);
  const contact = contacts.find((c) => c.publicKey === publicKey);
  if (contact?.advType === ADV_TYPE_ROOM) return { kind: 'room', publicKey };
  return { kind: 'dm', publicKey };
}
