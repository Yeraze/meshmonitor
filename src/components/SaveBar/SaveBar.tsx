import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBarContext, SaveBarSection } from '../../contexts/SaveBarContext';
import './SaveBar.css';

export const SaveBar: React.FC = () => {
  const { t } = useTranslation();
  const { sections, activeSection, setActiveSection } = useSaveBarContext();
  // True for the full duration of a batch save, so the buttons stay disabled
  // between sequential section saves (no re-enable window for double-clicks).
  const [isBatchSaving, setIsBatchSaving] = useState(false);

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

  // When the active section belongs to a group, a single Save/Dismiss action
  // applies to every changed section in that group ("Save All"). Ungrouped
  // sections (e.g. Device Configuration) keep the per-section tab behavior.
  const groupSections = effectiveSection.group
    ? sectionsWithChanges.filter(s => s.group === effectiveSection.group)
    : [effectiveSection];
  const isBatch = groupSections.length > 1;
  const anySaving = isBatchSaving || groupSections.some(s => s.isSaving);

  const handleSave = async () => {
    // Save sequentially so sections that hit the same endpoint don't race.
    // Each section's onSave handles its own errors/toasts, but guard anyway so
    // one failure doesn't abort the rest of the batch.
    setIsBatchSaving(true);
    try {
      for (const section of groupSections) {
        try {
          await section.onSave();
        } catch {
          // section reports its own failure; continue with the remaining sections
        }
      }
    } finally {
      setIsBatchSaving(false);
    }
  };

  const handleDismiss = () => {
    for (const section of groupSections) {
      section.onDismiss();
    }
  };

  const handleSectionClick = (sectionId: string) => {
    setActiveSection(sectionId);
  };

  // Per-section tabs are only meaningful for ungrouped sections — a grouped
  // batch saves them all at once, so picking one isn't necessary.
  const showTabs = !effectiveSection.group && sectionsWithChanges.length > 1;

  return (
    <div className="save-bar">
      <div className="save-bar-content">
        <div className="save-bar-left">
          {showTabs && (
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
            {isBatch
              ? t('savebar.save_all_changes', { count: groupSections.length })
              : t('savebar.save_changes_to', { section: effectiveSection.sectionName })}
          </span>
        </div>
        <div className="save-bar-actions">
          <button
            className="save-bar-dismiss"
            onClick={handleDismiss}
            disabled={anySaving}
          >
            {t('common.dismiss')}
          </button>
          <button
            className="save-bar-save"
            onClick={handleSave}
            disabled={anySaving}
          >
            {anySaving
              ? t('common.saving')
              : isBatch
                ? t('savebar.save_all')
                : t('common.save')}
          </button>
        </div>
      </div>
      {showTabs && (
        <div className="save-bar-badge">
          {sectionsWithChanges.length}
        </div>
      )}
    </div>
  );
};

export default SaveBar;
