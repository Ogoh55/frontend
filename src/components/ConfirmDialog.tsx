"use client";

import { useEffect, useId } from "react";
import { useFocusTrap } from "../lib/hooks/useFocusTrap";

interface Props {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

/**
 * Confirm dialog — the final "are you sure?" gate before a trade or
 * destructive action. Centered on desktop, bottom-anchored on compact
 * screens (matches the .zn-confirm-backdrop / .zn-confirm-panel CSS rules
 * in globals.css).
 *
 * Focus is trapped inside and restored on close, starting on the confirm
 * button; Escape and backdrop click cancel; Enter / Space on the confirm
 * button proceeds. Ids are per-instance so a confirm nested in another
 * dialog (e.g. the roll wizard) doesn't collide.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  // Traps Tab inside the panel, starts on [data-autofocus], restores focus on close
  const panelRef = useFocusTrap<HTMLDivElement>(open);

  // Escape to cancel
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmColor = destructive ? "var(--put)" : "var(--brand)";

  return (
    <div
      className="zn-confirm-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="zn-confirm-panel"
      >
        <div
          id={titleId}
          style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 10 }}
        >
          {title}
        </div>

        {description && (
          <div id={descriptionId} style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6, marginBottom: 16 }}>
            {description}
          </div>
        )}

        {children}

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "10px 0",
              background: "none",
              border: "1px solid var(--border-default)",
              color: "var(--text-mid)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-autofocus
            onClick={onConfirm}
            style={{
              flex: 1,
              padding: "10px 0",
              background: confirmColor,
              border: "none",
              color: destructive ? "#fff" : "var(--bg)",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
