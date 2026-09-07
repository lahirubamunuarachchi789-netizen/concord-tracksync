'use client';

// ============================================================
// ErrorModal - CENTERED modal / popup alert for validation
// failures and database insertion/update errors on the
// transaction & data-entry forms (Standard Transactions,
// QR Activation, Data Admin).
//
// Instead of a small corner toast, a failed validation rule or a
// blocked / failed database write is surfaced as a prominent alert
// dead-center of the screen (dimmed + blurred backdrop) so it
// immediately grabs the user's attention. The dialog stays open
// until it is explicitly dismissed with the "OK" button, the
// Escape key or a click on the backdrop.
//
// `error` shape: { title, message } | null
// ============================================================

import { useEffect, useRef } from 'react';
import { AlertCircleIcon } from './icons';

export default function ErrorModal({ error, onClose }) {
  const okRef = useRef(null);

  // Focus "OK" on open, dismiss on Escape and lock body scroll
  // while the blocking dialog is visible.
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => okRef.current?.focus(), 30);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [error, onClose]);

  if (!error) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="error-modal-title"
      aria-describedby={error.message ? 'error-modal-message' : undefined}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="animate-modal-pop w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl shadow-red-900/20 ring-1 ring-red-100">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 ring-1 ring-red-100">
            <AlertCircleIcon className="h-6 w-6 text-red-500" />
          </span>
          <div className="min-w-0">
            <h2 id="error-modal-title" className="text-base font-bold leading-snug text-slate-900">
              {error.title}
            </h2>
            {error.message ? (
              <p
                id="error-modal-message"
                className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-slate-600"
              >
                {error.message}
              </p>
            ) : null}
          </div>
        </div>

        <button
          ref={okRef}
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-red-600/25 transition hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
        >
          OK
        </button>
      </div>
    </div>
  );
}
