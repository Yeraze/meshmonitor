/**
 * Notes shown under a credential or URL input in the source edit form, for a
 * value the server holds but the form does not show.
 */
import { useTranslation } from 'react-i18next';

interface HiddenUrlPartsNoteProps {
  /** A URL field has credentials or a query string this viewer was not shown. */
  hidden: boolean;
}

export function HiddenUrlPartsNote({ hidden }: HiddenUrlPartsNoteProps) {
  const { t } = useTranslation();
  if (!hidden) return null;
  return (
    <span className="dashboard-form-help" data-testid="hidden-url-parts-note">
      {t(
        'source.form.url_parts_hidden',
        'This URL has stored credentials or a query string that are not shown. They are kept unless you change the scheme, host or port.',
      )}
    </span>
  );
}

interface DroppedSecretNoteProps {
  /** Saving now would drop the stored credential. */
  dropped: boolean;
}

export function DroppedSecretNote({ dropped }: DroppedSecretNoteProps) {
  const { t } = useTranslation();
  if (!dropped) return null;
  return (
    <span className="dashboard-form-help" role="status" data-testid="dropped-secret-note">
      {t(
        'source.form.secret_dropped_on_host_change',
        'The stored value is not kept when the scheme, host or port changes. Enter it again, or it will be removed.',
      )}
    </span>
  );
}
