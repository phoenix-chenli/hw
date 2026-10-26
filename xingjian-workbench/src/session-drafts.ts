import { useCallback, useRef, useState, type SetStateAction } from "react";

// Drafts belong to this browser tab. They are never business records or consent.
const prefix = "xingjian.draft.v1:";
const memory = new Map<string, unknown>();

export function readSessionDraft<T>(
  key: string,
  valid: (value: unknown) => value is T,
): T | null {
  let value = memory.get(key);
  if (value === undefined) {
    try {
      const raw = sessionStorage.getItem(prefix + key);
      if (raw !== null) value = JSON.parse(raw);
    } catch {
      // Unavailable storage must not prevent editing or saving to the server.
    }
  }
  if (value !== undefined && valid(value)) return value;
  return null;
}

export function writeSessionDraft<T>(key: string, value: T) {
  memory.set(key, value);
  try {
    sessionStorage.setItem(prefix + key, JSON.stringify(value));
  } catch {
    // Avoid recovering an older value if storage fills up during this edit.
    try { sessionStorage.removeItem(prefix + key); } catch { /* unavailable */ }
  }
}

export function clearSessionDraft(key: string) {
  memory.delete(key);
  try { sessionStorage.removeItem(prefix + key); } catch { /* unavailable */ }
}

export function useSessionDraft<T>(
  key: string,
  initial: () => T,
  valid: (value: unknown) => value is T,
) {
  // Consumers remount on their project/entity key, just like the form itself.
  const [state, setState] = useState(() => {
    const saved = readSessionDraft(key, valid);
    return { value: saved ?? initial(), restored: saved !== null };
  });
  const current = useRef(state.value);
  const setValue = useCallback((change: SetStateAction<T>) => {
    const next = typeof change === "function"
      ? (change as (previous: T) => T)(current.current)
      : change;
    current.current = next;
    // Write on edit, rather than unmount: refresh and immediate close are safe.
    writeSessionDraft(key, next);
    setState((previous) => ({ ...previous, value: next }));
  }, [key]);
  const clear = useCallback((resetValue?: T) => {
    // An older save can finish after this form was reopened and edited again.
    // Only clear the version that this mounted form actually submitted.
    const saved = readSessionDraft(key, (value): value is unknown => true);
    if (JSON.stringify(saved) === JSON.stringify(current.current))
      clearSessionDraft(key);
    if (resetValue !== undefined) current.current = resetValue;
    setState((previous) => ({
      value: resetValue === undefined ? previous.value : resetValue,
      restored: false,
    }));
  }, [key]);
  return { value: state.value, setValue, restored: state.restored, clear };
}
