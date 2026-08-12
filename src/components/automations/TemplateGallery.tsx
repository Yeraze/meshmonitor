/**
 * TemplateGallery (#4577 Phase 3 WP3) — install-flow UI for prebuilt automation
 * templates. Renders a card grid over the `TEMPLATES` registry (./templates),
 * a per-template param wizard that reuses AutomationBuilder's exported
 * `FieldInput` renderer, and installs the built automation(s) via
 * `POST /api/automations/import` (which always lands them disabled, for
 * review before the user turns them on).
 *
 * A template's `build()` may return ONE automation or an ARRAY — the latter
 * is the Phase 4 "bridge" shape (a template that installs a matched pair,
 * e.g. a MeshCore + Meshtastic half of the same behavior). Installs are
 * sequential and NOT transactional: if automation N fails to import, N-1
 * already exist in the database and are not rolled back. The wizard surfaces
 * per-automation success/failure so the user knows exactly what landed.
 */
import { useEffect, useState } from 'react';
import apiService from '../../services/api';
import { FieldInput, type SourceOption, type UnifiedChannelOption } from './AutomationBuilder';
import { fieldVisible } from './catalog';
import { UiIcon, UI_ICON_DEFINITIONS, type UiIconName } from '../icons';
import { validateAutomationGraph } from '../../types/automation';
import { TEMPLATES } from './templates';
import type { AutomationTemplate, BuiltAutomation } from './templates/types';
import styles from './TemplateGallery.module.css';

/** Minimal shape of a created automation row, as returned by POST /api/automations/import. */
export interface InstalledAutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  config: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TemplateGalleryProps {
  onClose: () => void;
  onInstalled: (createdRows: InstalledAutomationRow[]) => void;
  /** Defaults to the real registry; overridable so tests can inject a fake template. */
  templates?: AutomationTemplate[];
}

type SourcesResponse = Array<{
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  radio?: { txEnabled?: boolean; canTransmit?: boolean };
}>;

type InstallOutcome =
  | { status: 'success'; name: string; row: InstalledAutomationRow }
  | { status: 'error'; name: string; error: string };

/** Icon name is data (WP2's catalog), not a literal — fall back rather than crash on a typo. */
function TemplateIcon({ name, size = 28 }: { name: string; size?: number }) {
  const resolved = (name in UI_ICON_DEFINITIONS ? name : 'bot') as UiIconName;
  return <UiIcon name={resolved} size={size} />;
}

/** Seed the editable name/description from a first build() pass. Templates that need
 * required params may throw on an empty `{}` — that's fine, we just fall back. */
function seedFromBuild(template: AutomationTemplate): BuiltAutomation | null {
  try {
    const built = template.build({});
    const first = Array.isArray(built) ? built[0] : built;
    return first ?? null;
  } catch {
    return null;
  }
}

export default function TemplateGallery({ onClose, onInstalled, templates = TEMPLATES }: TemplateGalleryProps) {
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [channels, setChannels] = useState<UnifiedChannelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AutomationTemplate | null>(null);

  // Mirrors AutomationEditor's picker-data load (AutomationsPage.tsx): plain
  // GETs via apiService, independent try/catch per call so one endpoint
  // failing doesn't blank the other's data.
  useEffect(() => {
    Promise.all([
      apiService.get<SourcesResponse>('/api/sources'),
      apiService.get<UnifiedChannelOption[]>('/api/automations/channels'),
    ])
      .then(([ss, cs]) => {
        setSources((ss ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          enabled: s.enabled,
          txEnabled: s.radio?.txEnabled,
          canTransmit: s.radio?.canTransmit,
        })));
        setChannels(cs ?? []);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : 'Failed to load sources/channels');
      })
      .finally(() => setLoading(false));
  }, []);

  if (selected) {
    return (
      <TemplateWizard
        template={selected}
        sources={sources}
        channels={channels}
        onBack={() => setSelected(null)}
        onClose={onClose}
        onInstalled={onInstalled}
      />
    );
  }

  return (
    <div className={styles.gallery}>
      <div className={styles.header}>
        <h2 className={styles.title}>Template Gallery</h2>
        <button className="ae-btn ae-btn--ghost" onClick={onClose}>
          <UiIcon name="back" size={15} /> Close
        </button>
      </div>
      {loading && <div className="ae-muted">Loading…</div>}
      {loadError && <div className="ae-error-list">{loadError}</div>}
      {!loading && templates.length === 0 && (
        <div className="ae-empty">No templates available yet.</div>
      )}
      <div className={styles.grid}>
        {templates.map((t) => (
          <div className={`ae-card ${styles.card}`} key={t.id}>
            <div className={styles.cardHeader}>
              <TemplateIcon name={t.icon} />
              <div className={styles.cardName}>{t.name}</div>
            </div>
            <p className={styles.cardDescription}>{t.description}</p>
            <div className={styles.tags}>
              {t.tags.map((tag) => (
                <span className="ae-chip" key={tag}>{tag}</span>
              ))}
            </div>
            <button className="ae-btn ae-btn--primary" onClick={() => setSelected(t)}>
              Use template
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateWizard({ template, sources, channels, onBack, onClose, onInstalled }: {
  template: AutomationTemplate;
  sources: SourceOption[];
  channels: UnifiedChannelOption[];
  onBack: () => void;
  onClose: () => void;
  onInstalled: (rows: InstalledAutomationRow[]) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(() => seedFromBuild(template)?.name ?? template.name);
  const [description, setDescription] = useState(() => seedFromBuild(template)?.description ?? template.description);
  const [errors, setErrors] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [outcomes, setOutcomes] = useState<InstallOutcome[] | null>(null);

  const setParam = (fieldName: string, v: unknown) =>
    setValues((prev) => ({ ...prev, [fieldName]: v }));

  const install = async () => {
    setErrors([]);
    setOutcomes(null);

    let built: BuiltAutomation | BuiltAutomation[];
    try {
      built = template.build(values);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Failed to build this template from the entered values.']);
      return;
    }
    const list = Array.isArray(built) ? built.slice() : [built];
    if (list.length === 0) {
      setErrors(['This template produced no automations to install.']);
      return;
    }
    // The wizard's editable Name/Description apply to the first automation only —
    // a multi-automation (bridge) template's remaining rows keep their own
    // build()-derived identity.
    list[0] = { ...list[0], name, description };

    const validationErrors: string[] = [];
    for (const a of list) {
      const v = validateAutomationGraph(a.config);
      if (!v.valid) validationErrors.push(`"${a.name}": ${v.errors.join('; ')}`);
    }
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setInstalling(true);
    const results: InstallOutcome[] = [];
    // Sequential, not Promise.all — a later automation may depend on an earlier
    // one existing (Phase 4 bridge pairs), and sequential installs make the
    // partial-failure story ("which ones landed") deterministic to report.
    for (const a of list) {
      try {
        const row = await apiService.post<InstalledAutomationRow>('/api/automations/import', {
          name: a.name,
          description: a.description,
          config: a.config,
        });
        results.push({ status: 'success', name: a.name, row });
      } catch (e) {
        results.push({ status: 'error', name: a.name, error: e instanceof Error ? e.message : 'Install failed' });
      }
    }
    setInstalling(false);
    setOutcomes(results);

    const failed = results.filter((r) => r.status === 'error');
    if (failed.length === 0) {
      onInstalled(results.map((r) => (r as { status: 'success'; row: InstalledAutomationRow }).row));
    }
    // On partial failure we deliberately do NOT roll back the ones that
    // succeeded — they already exist (disabled) in the database. `outcomes`
    // below reports exactly which name(s) installed and which failed, and
    // `onInstalled` is withheld so the caller doesn't treat this as "done".
  };

  return (
    <div className={styles.wizard}>
      <div className={styles.header}>
        <button className="ae-btn ae-btn--ghost" onClick={onBack}>
          <UiIcon name="back" size={15} /> Back
        </button>
        <h2 className={styles.title}>
          <TemplateIcon name={template.icon} size={20} /> {template.name}
        </h2>
      </div>
      <p className={styles.cardDescription}>{template.description}</p>

      <div className="ae-field">
        <label className="ae-field-label">Name</label>
        <input className="ae-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="ae-field">
        <label className="ae-field-label">Description</label>
        <textarea className="ae-textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      {template.params.filter((p) => fieldVisible(p, values)).map((p) => (
        <FieldInput
          key={p.name}
          field={p}
          value={values[p.name]}
          variables={[]}
          sources={sources}
          channels={channels}
          scripts={[]}
          regions={[]}
          nodes={[]}
          triggerType="trigger.message"
          onChange={(v) => setParam(p.name, v)}
        />
      ))}

      {errors.length > 0 && (
        <ul className="ae-error-list">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      {outcomes && (
        <div className={styles.outcomes}>
          {outcomes.map((o) => (
            <div
              key={o.name}
              className={o.status === 'success' ? styles.outcomeOk : styles.outcomeFail}
            >
              {o.status === 'success'
                ? `Installed "${o.name}" (disabled — enable it from the automations list).`
                : `Failed to install "${o.name}": ${o.error}`}
            </div>
          ))}
        </div>
      )}

      <div className="ae-btn-row">
        <button className="ae-btn ae-btn--primary" disabled={installing} onClick={() => void install()}>
          {installing ? 'Installing…' : 'Install'}
        </button>
        <button className="ae-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
