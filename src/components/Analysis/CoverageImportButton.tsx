/**
 * Import button for the Coverage Report toolbar (#5891 P3, spec §2.10). Shown
 * to a signed-in viewer who holds `nodes:write` on at least one source that
 * can take an import. The auth context may be absent (anonymous and test
 * renders), as in CoverageWalkabout.
 */
import { useCallback, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../contexts/authContextObject';
import { UiIcon } from '../icons';
import { useCoverageImportSources } from '../../hooks/useCoverageImports';
import type { HasSourcePermission } from '../../hooks/useWalkaboutSources';
import { CoverageImportDialog } from './CoverageImportDialog';

function ButtonInner() {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const hasPermission = useCallback<HasSourcePermission>(
    (resource, action, opts) => !!auth?.hasPermission(resource, action, opts),
    [auth],
  );
  const sources = useCoverageImportSources(hasPermission, 'write');
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <>
      <button type="button" className="reports-btn" onClick={() => setOpen(true)} data-testid="coverage-import-button">
        <UiIcon name="import" size={14} />
        {t('analysis.coverage.import_button', 'Import')}
      </button>
      {open && <CoverageImportDialog isOpen onClose={() => setOpen(false)} sources={sources} />}
    </>
  );
}

export function CoverageImportButton() {
  const auth = useContext(AuthContext);
  if (!auth?.authStatus?.authenticated) return null;
  return <ButtonInner />;
}
