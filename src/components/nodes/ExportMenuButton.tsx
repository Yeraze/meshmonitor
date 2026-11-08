import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';

export interface ExportMenuButtonProps {
  disabled?: boolean;
  onExport: (format: 'csv' | 'html') => void;
}

/** Download icon button that opens a CSV / HTML export menu. */
export const ExportMenuButton: React.FC<ExportMenuButtonProps> = ({ disabled, onExport }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (format: 'csv' | 'html') => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setOpen(false);
    onExport(format);
  };

  return (
    <div className="export-dropdown" ref={ref}>
      <button
        type="button"
        className="sort-direction-btn export-trigger-btn"
        onClick={(e) => {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
        }}
        disabled={disabled}
        title={t('nodes.export', 'Export node list')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <UiIcon name="download" />
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <button
            type="button"
            className="export-menu-item"
            role="menuitem"
            onClick={pick('csv')}
            title={t('nodes.export_csv', 'Export node list as CSV')}
          >
            CSV
          </button>
          <button
            type="button"
            className="export-menu-item"
            role="menuitem"
            onClick={pick('html')}
            title={t('nodes.export_html', 'Export node list as HTML')}
          >
            HTML
          </button>
        </div>
      )}
    </div>
  );
};
