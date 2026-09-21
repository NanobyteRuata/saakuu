"use client";

import { useEffect, useRef, useState, type FocusEvent } from "react";

/**
 * Autosave for the template's properties forms (Phase 15, decision 72).
 *
 * Before this, switching fields with unsaved changes raised `Discard unsaved changes?` — a modal an
 * operator met once per field while building a twenty-field template, because quick-add only sets a
 * label and a type, so every field is finished in the properties form. A template is owned by one
 * user with no concurrent editing, so the modal protected against nothing; it only charged for the
 * product's normal way of working.
 *
 * The form is the unit, not the control: saving on each control's blur would fire a PATCH between
 * every two fields of the same form. So a save happens when focus leaves the form altogether, and
 * when the parent switches to another field, which it does by calling `flush` first.
 */
export type Flush = () => Promise<void>;

export function useAutosaveForm({
  dirty,
  save,
  registerFlush,
}: {
  dirty: boolean;
  save: () => Promise<void>;
  /** Lets the parent save this form before it swaps in another one. */
  registerFlush?: (flush: Flush | null) => void;
}): { onBlur: (e: FocusEvent<HTMLFormElement>) => void } {
  // The flush handed out must stay stable while still seeing the latest draft.
  const latest = useRef({ dirty, save });
  latest.current = { dirty, save };
  /*
   * Clicking another field blurs this form *and* asks the parent to flush it, so both paths ask for
   * the same save within a tick. One PATCH is enough: a field save recomputes mapping states and can
   * queue a rebuild, so the second one is not free.
   */
  const inFlight = useRef<Promise<void> | null>(null);

  const saveOnce = (): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!latest.current.dirty) return Promise.resolve();
    setSaving(true);
    const running = latest.current.save().finally(() => {
      inFlight.current = null;
      setSaving(false);
    });
    inFlight.current = running;
    return running;
  };
  const saveOnceRef = useRef(saveOnce);
  saveOnceRef.current = saveOnce;

  /*
   * Nothing is ever saved by pressing a button now, so a save can be in the air at the moment
   * someone closes the tab or hits reload. Client-side navigation is safe — the request outlives the
   * unmount — but a document unload would drop it, so that one case asks first, as the batch upload
   * and row review already do.
   */
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!saving) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving]);

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(() => saveOnceRef.current());
    return () => registerFlush(null);
  }, [registerFlush]);

  return {
    onBlur: (e: FocusEvent<HTMLFormElement>) => {
      // Moving between this form's own controls is not leaving it.
      const next = e.relatedTarget;
      if (next instanceof Node && e.currentTarget.contains(next)) return;
      void saveOnceRef.current();
    },
  };
}
