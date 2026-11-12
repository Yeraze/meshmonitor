/**
 * The composer's + menu (#6370): a button between the compose box and Send
 * that opens a short list of "insert something" entries. Callers supply the
 * entries (see ComposeInsertMenuItem), so new ones need no change here.
 * Unlike the emoji button it shows on phones too.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import type { ComposeInsertMenuItem } from './composeInsertMenuTypes';
import styles from './ComposeInsertMenu.module.css';

interface ComposeInsertMenuProps {
  items: readonly ComposeInsertMenuItem[];
  insert: (text: string) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

const ComposeInsertMenu: React.FC<ComposeInsertMenuProps> = ({ items, insert, disabled = false, disabledTitle }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open, close]);

  // Closing (e.g. the composer became disabled) also closes the menu.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (items.length === 0) return null;
  const label = t('messages.insert_menu', 'Insert');

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        title={disabled ? disabledTitle : label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <UiIcon name="plus" size={17} />
      </button>
      {open && (
        <div id={menuId} className={styles.menu} role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect(insert);
              }}
            >
              {item.icon && <UiIcon name={item.icon} size={16} />}
              <span className={styles.itemText}>
                <span>{item.label}</span>
                {item.disabled && item.disabledReason && (
                  <span className={styles.itemHint}>{item.disabledReason}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ComposeInsertMenu;
