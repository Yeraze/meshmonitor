/**
 * Debounced free-text packet search box (#6262), extracted from
 * `PacketMonitorPanel` (#4958). Keeps the field live and commits a trimmed
 * value (or undefined when empty) after a pause, so a keystroke does not
 * refetch.
 */
import React, { useEffect, useRef, useState } from 'react';

export interface PacketSearchInputProps {
  /** Committed search value (from the parent's filters). */
  value: string | undefined;
  onCommit: (next: string | undefined) => void;
  placeholder: string;
  title?: string;
  className?: string;
  debounceMs?: number;
  maxLength?: number;
}

const PacketSearchInput: React.FC<PacketSearchInputProps> = ({
  value,
  onCommit,
  placeholder,
  title,
  className = 'packet-search-input',
  debounceMs = 300,
  maxLength,
}) => {
  const [input, setInput] = useState(value ?? '');
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const committedRef = useRef(value);
  committedRef.current = value;

  // Follow external changes (e.g. "Clear filters").
  useEffect(() => {
    setInput(prev => ((prev.trim() || undefined) === value ? prev : value ?? ''));
  }, [value]);

  useEffect(() => {
    const next = input.trim() || undefined;
    if (next === committedRef.current) return;
    const id = setTimeout(() => onCommitRef.current(next), debounceMs);
    return () => clearTimeout(id);
  }, [input, debounceMs]);

  return (
    <input
      type="search"
      className={className}
      value={input}
      maxLength={maxLength}
      onChange={e => setInput(e.target.value)}
      placeholder={placeholder}
      title={title}
      aria-label={placeholder}
    />
  );
};

export default PacketSearchInput;
