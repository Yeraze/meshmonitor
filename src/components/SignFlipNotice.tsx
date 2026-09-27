/**
 * "Position auto-corrected (sign flip)" notice (#5363).
 *
 * Shown in node details and map popups when the server moved a node's
 * position to its mirror point. The reported coordinates stay visible so an
 * operator can ask the node's owner to fix them at the source.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './SignFlipNotice.module.css';

export interface SignFlipNoticeProps {
  reportedLatitude: number;
  reportedLongitude: number;
  /** `popup` = one compact grid row; `details` = the node details card. */
  variant?: 'popup' | 'details';
}

export const SignFlipNotice: React.FC<SignFlipNoticeProps> = ({
  reportedLatitude,
  reportedLongitude,
  variant = 'details',
}) => {
  const { t } = useTranslation();
  const coords = `${reportedLatitude.toFixed(5)}, ${reportedLongitude.toFixed(5)}`;
  return (
    <div
      className={variant === 'popup' ? `${styles.notice} ${styles.popup}` : styles.notice}
      data-testid="sign-flip-notice"
      title={t(
        'node_details.sign_flip_tooltip',
        'This node reported a position far from your reference point whose mirror image is nearby, so a missing minus sign is likely. The map shows the mirror point; the stored position is unchanged. Ask the owner to fix the coordinates on the node.',
      )}
    >
      <UiIcon name="alert" size={14} />
      <span className={styles.text}>
        <span className={styles.label}>
          {t('node_details.sign_flip_corrected', 'Position auto-corrected (sign flip)')}
        </span>
        <span className={styles.reported}>
          {t('node_details.sign_flip_reported', 'Reported: {{coords}}', { coords })}
        </span>
      </span>
    </div>
  );
};

export default SignFlipNotice;
