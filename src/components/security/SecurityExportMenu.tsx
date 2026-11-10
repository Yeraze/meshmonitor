import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';

interface SecurityExportMenuProps {
  onExport: (format: 'csv' | 'json') => void;
}

/** The Export dropdown in the page header. Same markup and classes for both protocols. */
export const SecurityExportMenu: React.FC<SecurityExportMenuProps> = ({ onExport }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pick = (format: 'csv' | 'json') => {
    setOpen(false);
    onExport(format);
  };
  return (
    <div className="header-actions">
      <div className="export-dropdown">
        <button
          onClick={() => setOpen(!open)}
          className="export-button"
          title={t('security.export_results')}
        >
          {t('security.export')} <UiIcon name="chevronDown" size={14} />
        </button>
        {open && (
          <div className="export-menu">
            <button onClick={() => pick('csv')} className="export-menu-item">
              {t('security.export_as_csv')}
            </button>
            <button onClick={() => pick('json')} className="export-menu-item">
              {t('security.export_as_json')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
