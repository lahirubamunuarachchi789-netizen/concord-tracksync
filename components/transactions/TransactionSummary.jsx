'use client';

// ============================================================
// TransactionSummary - right-hand column: pending record summary
// and the live session log with per-row sync state.
// ============================================================

import { useEffect, useState } from 'react';
import { CheckIcon, RefreshIcon, SpinnerIcon, TrashIcon, XCircleIcon } from '@/components/icons';

const QC_TONES = {
  Forward: 'emerald',
  'B Grade': 'amber',
  'C Grade': 'amber',
  'Lab Testing': 'indigo',
  Return: 'red',
  Reworked: 'indigo',
};

export function StatusChip({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 ring-slate-200',
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-100',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    amber: 'bg-amber-50 text-amber-700 ring-amber-100',
    red: 'bg-red-50 text-red-700 ring-red-100',
    purple: 'bg-purple-50 text-purple-700 ring-purple-100',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export default function TransactionSummary({
  user,
  statuses,
  lastScan,
  history,
  queuedCount,
  onRetrySync,
  syncing,
  onDeleteTransaction,
  deletingKey,
}) {
  // Two-step row deletion (bin icon): the first click arms the button
  // ("Confirm?"), the second click deletes. Disarms automatically after
  // 3s or when another row is armed - mirrors the PO delete pattern.
  const [confirmKey, setConfirmKey] = useState(null);
  useEffect(() => {
    if (!confirmKey) return undefined;
    const timer = setTimeout(() => setConfirmKey(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmKey]);

  // Stable key for a history row - matches the view's historyRowKey.
  const rowKeyOf = (tx) => tx?.client_ref ?? `${tx?.qr_code ?? ''}|${tx?.created_at ?? ''}`;

  return (
    <div className="flex flex-col gap-4">
      {/* Active workflow */}
      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
          Active workflow
        </h3>
        <dl className="mt-3 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Record status</dt>
            <dd>
              {statuses.record ? (
                <StatusChip tone={statuses.record === 'IN' ? 'emerald' : 'indigo'}>
                  {statuses.record}
                </StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">QC status</dt>
            <dd>
              {statuses.qc ? (
                <StatusChip tone={QC_TONES[statuses.qc] || 'slate'}>{statuses.qc}</StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Recorded by</dt>
            <dd className="truncate font-medium text-slate-700">
              {user?.username || '-'}
              <span className="ml-1 text-xs text-slate-400">({user?.department || '-'})</span>
            </dd>
          </div>
        </dl>
        {statuses.record && statuses.qc ? (
          <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
            Both statuses are locked. Every scan auto-submits with this combination.
          </p>
        ) : null}
      </section>

      {/* Queue health */}
      <section className="flex items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200">
        <div>
          <p className="text-sm font-bold text-slate-800">Offline queue</p>
          <p className="text-xs text-slate-400">
            {queuedCount > 0
              ? `${queuedCount} transaction${queuedCount === 1 ? '' : 's'} waiting to sync`
              : 'Everything is synced to Supabase'}
          </p>
        </div>
        {queuedCount > 0 ? (
          <button
            type="button"
            onClick={onRetrySync}
            disabled={syncing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
          >
            {syncing ? (
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshIcon className="h-3.5 w-3.5" />
            )}
            Sync now
          </button>
        ) : (
          <StatusChip tone="emerald">
            <CheckIcon className="h-3 w-3" /> Live
          </StatusChip>
        )}
      </section>

      {/* Session log */}
      <section className="rounded-2xl bg-white ring-1 ring-slate-200">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Recent transactions
          </h3>
          <span className="text-xs font-semibold text-slate-400">{history.length}</span>
        </header>
        <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
          {history.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              Transactions recorded in this session will appear here.
            </p>
          ) : (
            history.map((tx) => {
              const rowKey = rowKeyOf(tx);
              const confirming = confirmKey === rowKey;
              const deleting = deletingKey === rowKey;
              return (
                <div key={rowKey} className="flex items-start gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-semibold text-slate-900">
                      {tx.qr_code}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StatusChip tone={tx.record_status === 'IN' ? 'emerald' : 'indigo'}>
                        {tx.record_status}
                      </StatusChip>
                      <StatusChip tone={QC_TONES[tx.qc_status] || 'slate'}>
                        {tx.qc_status}
                      </StatusChip>
                      <StatusChip tone={tx.count < 0 ? 'red' : 'emerald'}>
                        {tx.count > 0 ? `+${tx.count}` : tx.count}
                      </StatusChip>
                      <span className="text-[11px] text-slate-400">
                        {new Date(tx.created_at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {' · '}
                        {tx.created_by}
                      </span>
                    </p>
                  </div>
                  {tx._source === 'queued' ? (
                    <StatusChip tone="amber">
                      <RefreshIcon className="h-3 w-3" /> Queued
                    </StatusChip>
                  ) : tx._source === 'failed' ? (
                    <StatusChip tone="red">
                      <XCircleIcon className="h-3 w-3" /> Failed
                    </StatusChip>
                  ) : (
                    <StatusChip tone="emerald">
                      <CheckIcon className="h-3 w-3" /> Synced
                    </StatusChip>
                  )}
                  {onDeleteTransaction ? (
                    <button
                      type="button"
                      onClick={() =>
                        confirming ? onDeleteTransaction(tx) : setConfirmKey(rowKey)
                      }
                      disabled={Boolean(deletingKey)}
                      aria-label={
                        confirming ? 'Confirm delete transaction' : 'Delete transaction'
                      }
                      title={
                        confirming ? 'Click again to confirm' : 'Delete this transaction'
                      }
                      className={`mt-0.5 shrink-0 rounded-lg p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-50 ${
                        confirming
                          ? 'bg-red-600 text-white shadow-sm'
                          : 'text-slate-300 hover:bg-red-50 hover:text-red-600'
                      }`}
                    >
                      {deleting ? (
                        <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <TrashIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
