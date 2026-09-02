'use client';

// ============================================================
// ActivationSummary - right-hand column: locked workflow
// parameters, queue health and the recent activation log.
// ============================================================

import { CheckIcon, RefreshIcon, SpinnerIcon, XCircleIcon } from '@/components/icons';
import { StatusChip } from '../TransactionSummary';

export default function ActivationSummary({
  user,
  params,
  limitInfo,
  history,
  queuedCount,
  onRetrySync,
  syncing,
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Active workflow */}
      <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
          Active workflow
        </h3>
        <dl className="mt-3 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Purchase order</dt>
            <dd>
              {params.po ? (
                <StatusChip tone="indigo">{params.po}</StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Size</dt>
            <dd>
              {params.size ? (
                <StatusChip tone="purple">{params.size}</StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Record status</dt>
            <dd>
              {params.record ? (
                <StatusChip tone="emerald">{params.record}</StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">QC status</dt>
            <dd>
              {params.qc ? (
                <StatusChip tone="amber">{params.qc}</StatusChip>
              ) : (
                <span className="text-slate-300">Not selected</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Activated by</dt>
            <dd className="truncate font-medium text-slate-700">
              {user?.username || '-'}
              <span className="ml-1 text-xs text-slate-400">({user?.department || '-'})</span>
            </dd>
          </div>
        </dl>
        {params.po && params.size && params.record && params.qc ? (
          <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100">
            All parameters are locked. Every scan auto-activates with this combination.
          </p>
        ) : null}
      </section>

      {/* Cut Qty limit guard - verdict of the most recent scan evaluation */}
      <section
        className={`rounded-2xl bg-white p-5 ring-1 transition ${
          limitInfo && !limitInfo.allowed ? 'ring-2 ring-red-300' : 'ring-slate-200'
        }`}
      >
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Cut Qty limit
          </h3>
          {limitInfo ? (
            limitInfo.allowed ? (
              <StatusChip tone="emerald">
                <CheckIcon className="h-3 w-3" /> Within limit
              </StatusChip>
            ) : (
              <StatusChip tone="red">
                <XCircleIcon className="h-3 w-3" /> Exceeded
              </StatusChip>
            )
          ) : null}
        </header>
        {limitInfo ? (
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-slate-50 px-2 py-2.5 ring-1 ring-slate-100">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Current
              </p>
              <p className="text-lg font-extrabold text-slate-800">{limitInfo.currentSum}</p>
            </div>
            <div className="rounded-xl bg-indigo-50 px-2 py-2.5 ring-1 ring-indigo-100">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-400">
                Cut Qty
              </p>
              <p className="text-lg font-extrabold text-indigo-700">{limitInfo.cutQty ?? '—'}</p>
            </div>
            <div
              className={`rounded-xl px-2 py-2.5 ring-1 ${
                limitInfo.allowed
                  ? 'bg-emerald-50 ring-emerald-100'
                  : 'bg-red-50 ring-red-100'
              }`}
            >
              <p
                className={`text-[11px] font-semibold uppercase tracking-wide ${
                  limitInfo.allowed ? 'text-emerald-500' : 'text-red-400'
                }`}
              >
                After scan
              </p>
              <p
                className={`text-lg font-extrabold ${
                  limitInfo.allowed ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {limitInfo.projected}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Every scan is checked against the pod cut_qty for the locked PO + size before it is
            saved.
          </p>
        )}
      </section>

      {/* Queue health */}
      <section className="flex items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200">
        <div>
          <p className="text-sm font-bold text-slate-800">Offline queue</p>
          <p className="text-xs text-slate-400">
            {queuedCount > 0
              ? `${queuedCount} activation${queuedCount === 1 ? '' : 's'} waiting to sync`
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
            Recent activations
          </h3>
          <span className="text-xs font-semibold text-slate-400">{history.length}</span>
        </header>
        <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
          {history.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-400">
              Activated QR codes will appear here.
            </p>
          ) : (
            history.map((row, index) => (
              <div
                key={row.id ?? `${row.created_at}-${index}`}
                className="flex items-start gap-3 px-5 py-3.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-semibold text-slate-900">
                    {row.qr_code}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {row.record_status ? (
                      <StatusChip tone="emerald">{row.record_status}</StatusChip>
                    ) : null}
                    {row.qc_status ? <StatusChip tone="amber">{row.qc_status}</StatusChip> : null}
                    {row.count != null ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${
                          row.count < 0
                            ? 'bg-red-50 text-red-600 ring-red-100'
                            : 'bg-slate-50 text-slate-600 ring-slate-200'
                        }`}
                      >
                        {row.count > 0 ? `+${row.count}` : row.count}
                      </span>
                    ) : null}
                    <span className="text-[11px] text-slate-400">
                      {new Date(row.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {' · '}
                      {row.created_by}
                    </span>
                  </p>
                </div>
                {row._source === 'queued' ? (
                  <StatusChip tone="amber">
                    <RefreshIcon className="h-3 w-3" /> Queued
                  </StatusChip>
                ) : row._source === 'failed' ? (
                  <StatusChip tone="red">
                    <XCircleIcon className="h-3 w-3" /> Failed
                  </StatusChip>
                ) : (
                  <StatusChip tone="emerald">
                    <CheckIcon className="h-3 w-3" /> Synced
                  </StatusChip>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}