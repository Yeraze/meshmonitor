/**
 * Leading kind marker for a MeshCore channel (#6228).
 *
 * Renders a small icon in front of a channel name so the three kinds read
 * apart at a glance wherever channels are listed:
 *
 *  - **public**  — a globe, because the channel is world-readable.
 *  - **private** — a closed padlock, because the secret is shared only among
 *    members.
 *  - **hashtag** — no icon: the leading `#` already in the channel's name is
 *    its own marker, so a second glyph would be redundant.
 *
 * Classification is centralised in `meshcoreChannelKind` — this component only
 * picks the glyph and its tooltip. Icons go through `UiIcon` (never a hardcoded
 * emoji) so emoji-mode and theming keep working.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { meshcoreChannelKind } from '../../utils/meshcoreChannelKind';

interface MeshCoreChannelMarkerProps {
  id: number;
  name: string | null | undefined;
  size?: number;
}

export const MeshCoreChannelMarker: React.FC<MeshCoreChannelMarkerProps> = ({ id, name, size = 13 }) => {
  const { t } = useTranslation();
  const kind = meshcoreChannelKind({ id, name });

  if (kind === 'public') {
    return (
      <UiIcon
        name="globe"
        size={size}
        title={t('meshcore.channels.kind.public', 'Public channel')}
        style={{ marginRight: 4, flexShrink: 0 }}
      />
    );
  }
  if (kind === 'private') {
    return (
      <UiIcon
        name="encrypted"
        size={size}
        title={t('meshcore.channels.kind.private', 'Private channel')}
        style={{ marginRight: 4, flexShrink: 0 }}
      />
    );
  }
  // hashtag: the leading '#' in the channel name is its own marker.
  return null;
};
