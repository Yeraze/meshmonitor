/**
 * Automation picker for action.setAutomationEnabled (#5445).
 *
 * A dropdown of existing automations (shown by name, stored by id) plus an
 * "Enter an id or template" choice that swaps in a token-aware text field, so a
 * rule can target `{{ var.someId }}` or an id that is not in the list.
 */
import { useState } from 'react';
import TokenTextField from './TokenTextField';
import styles from './AutomationIdFieldInput.module.css';

export interface AutomationOption { id: string; name: string; enabled?: boolean; }

const CUSTOM = '__custom__';

export default function AutomationIdFieldInput({ value, onChange, automations, triggerType, variableNames }: {
  value: unknown;
  onChange: (v: unknown) => void;
  automations: AutomationOption[];
  triggerType: string;
  variableNames: string[];
}) {
  const current = typeof value === 'string' ? value : '';
  const known = automations.some((a) => a.id === current);
  const [customChosen, setCustomChosen] = useState(false);
  // A saved value that matches no listed automation (a template, or a deleted
  // automation's id) opens in custom mode so the user can see and fix it.
  const custom = customChosen || (current !== '' && !known);
  const selectValue = known && !customChosen ? current : custom ? CUSTOM : '';

  return (
    <div className={styles.picker}>
      <select
        className="ae-select"
        aria-label="Automation"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            setCustomChosen(true);
            // Keep a template the user already typed; drop a picked id so the
            // text field starts empty rather than showing an opaque id.
            if (known) onChange('');
            return;
          }
          setCustomChosen(false);
          onChange(v);
        }}
      >
        <option value="">— select an automation —</option>
        {automations.map((a) => (
          <option key={a.id} value={a.id}>{a.name}{a.enabled === false ? ' (disabled)' : ''}</option>
        ))}
        <option value={CUSTOM}>Enter an id or template…</option>
      </select>
      {custom && (
        <>
          <TokenTextField
            value={current}
            placeholder="automation id, or {{ var.targetAutomation }}"
            triggerType={triggerType}
            variableNames={variableNames}
            onChange={onChange}
          />
          {current !== '' && !current.includes('{{') && !known && automations.length > 0 && (
            <div className={styles.unknown}>No automation has this id. The step will fail unless one is created with it.</div>
          )}
        </>
      )}
    </div>
  );
}
