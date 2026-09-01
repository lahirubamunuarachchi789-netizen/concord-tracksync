'use client';

import { AlertCircleIcon, CheckCircleIcon, InfoCircleIcon, XIcon } from './icons';

const VARIANT_STYLES = {
  success: {
    wrapper: 'border-emerald-200 bg-emerald-50/95 text-emerald-900',
    icon: 'text-emerald-500',
    Icon: CheckCircleIcon,
  },
  error: {
    wrapper: 'border-red-200 bg-red-50/95 text-red-900',
    icon: 'text-red-500',
    Icon: AlertCircleIcon,
  },
  info: {
    wrapper: 'border-sky-200 bg-sky-50/95 text-sky-900',
    icon: 'text-sky-500',
    Icon: InfoCircleIcon,
  },
};

/**
 * Toast-style status notification (success / error / info).
 * `toast` shape: { id, type, title, message } | null
 */
export default function Notification({ toast, onClose }) {
  if (!toast) return null;

  const variant = VARIANT_STYLES[toast.type] || VARIANT_STYLES.info;
  const Icon = variant.Icon;

  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 top-5 z-50 flex justify-center sm:justify-end sm:pr-2"
    >
      <div
        className={`animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border px-4 py-3.5 shadow-xl shadow-slate-900/10 backdrop-blur ${variant.wrapper}`}
      >
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${variant.icon}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{toast.title}</p>
          {toast.message ? (
            <p className="mt-0.5 text-sm leading-snug opacity-80">{toast.message}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss notification"
          className="rounded-md p-0.5 opacity-50 transition hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
