import React from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_LANGUAGES } from '../config/i18n';

interface LanguageSelectorProps {
  value: string;
  onChange: (language: string) => void;
  className?: string;
}

/**
 * Language selector dropdown for choosing the UI language.
 * Uses available languages from i18n configuration.
 */
export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  value,
  onChange,
  className = 'setting-input'
}) => {
  const { t } = useTranslation();

  return (
    <select
      id="language"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      aria-label={t('settings.language')}
    >
      {AVAILABLE_LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.nativeName} ({lang.name})
        </option>
      ))}
    </select>
  );
};

export default LanguageSelector;
