import React from 'react';
import { useTranslation } from 'react-i18next';
import { MESHCORE_AUTOMATION_TOKENS } from './meshcoreAutomationTokens';

/**
 * Inline "Available tokens: {VERSION}, …" legend. Rendered under the
 * label of any token-aware text field so operators can see the full set
 * without hunting through docs. Matches the styling used by the
 * auto-announce message field.
 */
export const MeshCoreTokenLegend: React.FC = () => {
  const { t } = useTranslation();
  return (
    <span
      className="setting-description"
      style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.8rem' }}
    >
      {t('meshcore.automation.available_tokens', 'Available tokens:')}{' '}
      {MESHCORE_AUTOMATION_TOKENS.join(', ')}
    </span>
  );
};
