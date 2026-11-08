/**
 * LocalMarkerAuthoringUi — the placement hint and editor modal that go with
 * `useLocalMarkerAuthoring` (#5686). One shared piece for every map that
 * offers local markers.
 */
import { useTranslation } from 'react-i18next';
import LocalMarkerEditorModal from './LocalMarkerEditorModal';
import type { LocalMarkerAuthoring } from '../../hooks/useLocalMarkerAuthoring';

export function LocalMarkerAuthoringUi({ authoring }: { authoring: LocalMarkerAuthoring }) {
  const { t } = useTranslation();
  const { placing, setPlacing, editor } = authoring;
  return (
    <>
      {placing && (
        <div className="waypoint-placement-hint" role="status">
          <span>{t('localMarkers.placeHint', 'Click the map to place the local marker')}</span>
          <button type="button" onClick={() => setPlacing(false)}>
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}
      <LocalMarkerEditorModal
        isOpen={editor.open}
        initial={editor.initial}
        defaultCoords={editor.defaultCoords}
        onClose={editor.close}
        onSave={editor.save}
      />
    </>
  );
}

export default LocalMarkerAuthoringUi;
