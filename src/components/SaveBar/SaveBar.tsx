import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBarContext, SaveBarSection } from '../../contexts/SaveBarContext';
import './SaveBar.css';

export const SaveBar: React.FC = () => {
  const { t } = useTranslation();
  const { sections, activeSection, setActiveSection } = useSaveBarContext();

  // Get sections with changes
  const sectionsWithChanges: SaveBarSection[] = [];
  sections.forEach(section => {
    if (section.hasChanges) {
      sectionsWithChanges.push(section);
    }
  });

  // Don't render if no sections have changes
  if (sectionsWithChanges.length === 0) {
    return null;
  }

  // Get the active section, defaulting to the first one with changes
  const currentSectionId = activeSection || sectionsWithChanges[0]?.id;
  const currentSection = currentSectionId ? sections.get(currentSectionId) : null;

  // If active section no longer has changes, pick the first one that does
  const effectiveSection = currentSection?.hasChanges
    ? currentSection
    : sectionsWithChanges[0];

  if (!effectiveSection) {
    return null;
  }

  const handleSave = async () => {
    await effectiveSection.onSave();
  };

  const handleDismiss = () => {
    effectiveSection.onDismiss();
  };

  const handleSectionClick = (sectionId: string) => {
    setActiveSection(sectionId);
  };

  return (
    <div className="save-bar">
      <div className="save-bar-content">
        <div className="save-bar-left">
          {sectionsWithChanges.length > 1 && (
            <div className="save-bar-section-tabs">
              {sectionsWithChanges.map(section => (
                <button
                  key={section.id}
                  className={`save-bar-tab ${section.id === effectiveSection.id ? 'active' : ''}`}
                  onClick={() => handleSectionClick(section.id)}
                  disabled={section.isSaving}
                >
                  {section.sectionName}
                </button>
              ))}
            </div>
          )}
          <span className="save-bar-message">
            {t('savebar.save_changes_to', { section: effectiveSection.sectionName })}
          </span>
        </div>
        <div className="save-bar-actions">
          <button
            className="save-bar-dismiss"
            onClick={handleDismiss}
            disabled={effectiveSection.isSaving}
          >
            {t('common.dismiss')}
          </button>
          <button
            className="save-bar-save"
            onClick={handleSave}
            disabled={effectiveSection.isSaving}
          >
            {effectiveSection.isSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
      {sectionsWithChanges.length > 1 && (
        <div className="save-bar-badge">
          {sectionsWithChanges.length}
        </div>
      )}
    </div>
  );
};

export default SaveBar;
