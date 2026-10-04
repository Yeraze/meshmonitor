/**
 * Message-notification format editor (#5593).
 *
 * Two `{{ token }}` templates — title and body — for new-message notifications
 * on the current source, with a live preview rendered by the SAME function the
 * server uses (`renderMessageNotification`), so the preview cannot drift from
 * a real send. An empty field means "use the built-in default", which is shown
 * as the field's placeholder.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import TokenTextField from './automations/TokenTextField';
import { UiIcon } from './icons';
import {
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_BODY_TEMPLATE_MAX,
  MESSAGE_TEMPLATE_TOKENS,
  MESSAGE_TITLE_TEMPLATE_MAX,
  renderMessageNotification,
  type MessageTemplateContext,
} from '../utils/notificationTemplate';
import styles from './NotificationFormatSection.module.css';

export interface NotificationFormatSectionProps {
  /** Null = the built-in default. */
  titleTemplate: string | null;
  bodyTemplate: string | null;
  onChange: (next: { messageTitleTemplate: string | null; messageBodyTemplate: string | null }) => void;
  /** Name of the source being configured, used in the preview. */
  sourceName?: string | null;
  /** The user's "prefix with node name" setting, so the preview can show it. */
  prefixWithNodeName?: boolean;
}

const VALID_TOKENS: ReadonlySet<string> = new Set(MESSAGE_TEMPLATE_TOKENS);

/** Blank means "default": store null, never an empty string. */
function toStored(value: string): string | null {
  return value.trim().length === 0 ? null : value;
}

const NotificationFormatSection: React.FC<NotificationFormatSectionProps> = ({
  titleTemplate,
  bodyTemplate,
  onChange,
  sourceName,
  prefixWithNodeName,
}) => {
  const { t } = useTranslation();
  const title = titleTemplate ?? '';
  const body = bodyTemplate ?? '';

  const samples = useMemo(() => {
    const base = {
      sourceName: sourceName || t('notifications.format_sample_source'),
      senderName: t('notifications.format_sample_sender'),
      senderShortName: t('notifications.format_sample_sender_short'),
      text: t('notifications.format_sample_text'),
      serviceLabel: 'Meshtastic',
    };
    const channel: MessageTemplateContext = {
      ...base,
      channelName: t('notifications.format_sample_channel'),
      isDM: false,
    };
    const dm: MessageTemplateContext = { ...base, channelName: '', isDM: true };
    return { channel, dm };
  }, [sourceName, t]);

  const templates = { titleTemplate, bodyTemplate };
  const previews = [
    { key: 'channel', icon: 'channels' as const, label: t('notifications.format_preview_channel'), rendered: renderMessageNotification(samples.channel, templates) },
    { key: 'dm', icon: 'directMessages' as const, label: t('notifications.format_preview_dm'), rendered: renderMessageNotification(samples.dm, templates) },
  ];
  const nodePrefix = prefixWithNodeName ? `[${t('notifications.format_sample_node')}] ` : '';

  const setTitle = (value: string) =>
    onChange({ messageTitleTemplate: toStored(value), messageBodyTemplate: bodyTemplate });
  const setBody = (value: string) =>
    onChange({ messageTitleTemplate: titleTemplate, messageBodyTemplate: toStored(value) });
  const isDefault = titleTemplate === null && bodyTemplate === null;

  return (
    <div className={styles.section} data-testid="notification-format-section">
      <h4 className={styles.heading}>
        <UiIcon name="text" /> {t('notifications.format_title')}
      </h4>
      <p className={styles.description}>{t('notifications.format_description')}</p>

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="notif-format-title">
          {t('notifications.format_title_label')}
        </label>
        <TokenTextField
          id="notif-format-title"
          value={title}
          onChange={setTitle}
          validTokens={VALID_TOKENS}
          fieldClassName={styles.field}
          maxLength={MESSAGE_TITLE_TEMPLATE_MAX}
          placeholder={DEFAULT_MESSAGE_TEMPLATES.channel.title}
        />
        <div className={styles.fieldMeta}>
          <span>{t('notifications.format_empty_uses_default')}</span>
          <span>{title.length}/{MESSAGE_TITLE_TEMPLATE_MAX}</span>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="notif-format-body">
          {t('notifications.format_body_label')}
        </label>
        <TokenTextField
          id="notif-format-body"
          multiline
          value={body}
          onChange={setBody}
          validTokens={VALID_TOKENS}
          fieldClassName={`${styles.field} ${styles.fieldMultiline}`}
          maxLength={MESSAGE_BODY_TEMPLATE_MAX}
          placeholder={DEFAULT_MESSAGE_TEMPLATES.channel.body}
        />
        <div className={styles.fieldMeta}>
          <span>{t('notifications.format_empty_uses_default')}</span>
          <span>{body.length}/{MESSAGE_BODY_TEMPLATE_MAX}</span>
        </div>
      </div>

      <div className={styles.tokens}>
        <p className={styles.tokensTitle}>{t('notifications.format_tokens_title')}</p>
        <ul className={styles.tokenList}>
          {MESSAGE_TEMPLATE_TOKENS.map((token) => (
            <li key={token} className={styles.tokenItem}>
              <button
                type="button"
                className={styles.tokenButton}
                title={t('notifications.format_token_insert')}
                onClick={() => setBody(`${body}{{ ${token} }}`)}
              >
                {`{{ ${token} }}`}
              </button>
              <span>{t(`notifications.format_token_${token}`)}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className={styles.previewTitle}>{t('notifications.format_preview_title')}</p>
      <div className={styles.previews}>
        {previews.map((p) => (
          <div key={p.key} className={styles.preview} data-testid={`notification-format-preview-${p.key}`}>
            <div className={styles.previewKind}>
              <UiIcon name={p.icon} size={14} /> {p.label}
            </div>
            <div className={styles.previewHeadline} data-testid={`notification-format-preview-${p.key}-title`}>
              {p.rendered.title}
            </div>
            <div className={styles.previewBody} data-testid={`notification-format-preview-${p.key}-body`}>
              {nodePrefix}{p.rendered.body}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.resetButton}
          disabled={isDefault}
          onClick={() => onChange({ messageTitleTemplate: null, messageBodyTemplate: null })}
        >
          <UiIcon name="refresh" size={14} /> {t('notifications.format_reset')}
        </button>
        <span className={styles.note}>{t('notifications.format_note')}</span>
      </div>
    </div>
  );
};

export default NotificationFormatSection;
