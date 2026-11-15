/**
 * Guest-password hint for MeshCore room server logins (#6407).
 *
 * Stock room server firmware sets its guest password to "hello"
 * (ROOM_PASSWORD in most variants). A blank password only gets read-only
 * access when the room allows it, otherwise the room never replies. Used by
 * the Rooms view and the remote console's room login; repeaters do not
 * share this default, so callers must not show it for them.
 */
import { useTranslation } from 'react-i18next';
import styles from './MeshCoreRoomGuestHint.module.css';

export const STOCK_ROOM_GUEST_DEFAULT = 'hello';

interface Props {
  onUseDefault: (password: string) => void;
  disabled?: boolean;
  className?: string;
}

export function MeshCoreRoomGuestHint({ onUseDefault, disabled, className }: Props) {
  const { t } = useTranslation();
  return (
    <p className={`${styles.hint}${className ? ` ${className}` : ''}`}>
      {t(
        'meshcore.rooms.guest_password_hint',
        'Stock room servers use the guest password "hello". A blank password gets read-only access only if the room allows it.',
      )}{' '}
      <button
        type="button"
        className={styles.useDefault}
        onClick={() => onUseDefault(STOCK_ROOM_GUEST_DEFAULT)}
        disabled={disabled}
      >
        {t('meshcore.rooms.use_guest_password', 'Use "hello"')}
      </button>
    </p>
  );
}
