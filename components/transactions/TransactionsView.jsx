'use client';

// ============================================================
// TransactionsView - orchestrates dual QR scanning (camera /
// scanner gun), quick status selection and transaction recording.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Notification from '@/components/Notification';
import PageHeader from '@/components/PageHeader';
import { CheckIcon, SpinnerIcon } from '@/components/icons';
import { useSession } from '@/components/AppShell';
import GunScannerInput from './GunScannerInput';
import ScanMethodToggle from './ScanMethodToggle';
import ScanPreview from './ScanPreview';
import StatusControls from './StatusControls';
import TransactionSummary, { StatusChip } from './TransactionSummary';
import {
  createTransaction,
  getQueuedCount,
  getRecentTransactions,
  retryQueuedTransactions,
} from '@/lib/transactionsService';

const CameraScanner = dynamic(() => import('./CameraScanner'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-slate-200 bg-slate-900">
      <SpinnerIcon className="h-6 w-6 animate-spin text-indigo-300" />
    </div>
  ),
});

const ACTIVE_GRADIENT =
  'bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 shadow-lg shadow-indigo-600/25 hover:shadow-indigo-600/40';

export default function TransactionsView() {
  const user = useSession();
  const [method, setMethod] = useState('gun');
  const [draft, setDraft] = useState({
    scan: null, // { value, source, at }
    recordStatus: '',
    qcStatus: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = useCallback((type, title, message) => {
    setToast({ id: Date.now(), type, title, message });
  }, []);

  // Auto-dismiss toasts after 4.5s.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ------------------------- initial load ------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { flushed } = await retryQueuedTransactions();
      const rows = await getRecentTransactions(25);
      if (cancelled) return;
      setHistory(rows);
      setQueuedCount(getQueuedCount());
      if (flushed > 0) {
        notify('success', 'Sync complete', `${flushed} offline transaction(s) uploaded.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // Auto-retry the queue when connectivity returns.
  useEffect(() => {
    async function retry() {
      setSyncing(true);
      const { flushed } = await retryQueuedTransactions();
      const rows = await getRecentTransactions(25);
      setHistory(rows);
      setQueuedCount(getQueuedCount());
      setSyncing(false);
      if (flushed > 0) {
        notify('success', 'Back online', `${flushed} queued transaction(s) synced.`);
      }
    }
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [notify]);

  /* --------------------------- scanning --------------------------- */

  const handleScan = useCallback((value, source) => {
    setDraft((prev) => {
      if (prev.scan?.value === value && Date.now() - prev.scan.at < 1500) return prev;
      return { ...prev, scan: { value, source, at: Date.now() } };
    });
  }, []);

  /* --------------------------- recording -------------------------- */

  async function submitTransaction() {
    if (!draft.scan?.value || !draft.recordStatus || !draft.qcStatus || submitting) return;
    setSubmitting(true);
    const result = await createTransaction(
      user,
      draft.scan.value,
      draft.recordStatus,
      draft.qcStatus
    );
    setHistory((prev) => [result.row, ...prev].slice(0, 25));
    setQueuedCount(getQueuedCount());
    setSubmitting(false);
    if (result.status === 'synced') {
      notify('success', 'Transaction recorded', `${draft.scan.value} · ${draft.recordStatus} · ${draft.qcStatus}`);
    } else {
      notify('info', 'Saved on device', result.error);
    }
  }

  const scanReady = Boolean(draft.scan?.value);
  const canSubmit = scanReady && draft.recordStatus && draft.qcStatus;

  function handleRetrySync() {
    setSyncing(true);
    (async () => {
      const { flushed } = await retryQueuedTransactions();
      const rows = await getRecentTransactions(25);
      setHistory(rows);
      setQueuedCount(getQueuedCount());
      setSyncing(false);
      notify(
        flushed > 0 ? 'success' : 'info',
        flushed > 0 ? 'Sync complete' : 'Nothing to sync',
        flushed > 0
          ? `${flushed} queued transaction(s) uploaded to Supabase.`
          : 'All transactions are already up to date.'
      );
    })();
  }

  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Transactions"
        subtitle="Scan a QR code, pick the record & QC status, and log the movement instantly"
        actions={
          <StatusChip tone={queuedCount > 0 ? 'amber' : 'emerald'}>
            {queuedCount > 0 ? `${queuedCount} queued` : 'All synced'}
          </StatusChip>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-5">
        {/* Left: scanning + actions */}
        <div className="flex flex-col gap-5 xl:col-span-3">
          <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-slate-700">
              Scanning method
            </h2>
            <ScanMethodToggle method={method} onChange={setMethod} />

            <div className="mt-5">
              {method === 'camera' ? (
                <CameraScanner onScan={handleScan} />
              ) : (
                <GunScannerInput onScan={handleScan} />
              )}
            </div>
          </section>

          <ScanPreview
            key={draft.scan?.at || 'empty'}
            scan={draft.scan}
            onClear={() => setDraft((prev) => ({ ...prev, scan: null }))}
          />

          <StatusControls
            enabled={scanReady}
            recordStatus={draft.recordStatus}
            qcStatus={draft.qcStatus}
            onRecord={(status) =>
              setDraft((prev) => ({
                ...prev,
                recordStatus: prev.recordStatus === status ? '' : status,
              }))
            }
            onQc={(status) =>
              setDraft((prev) => ({ ...prev, qcStatus: prev.qcStatus === status ? '' : status }))
            }
          />

          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={submitTransaction}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-base font-extrabold text-white transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 ${ACTIVE_GRADIENT}`}
          >
            {submitting ? (
              <SpinnerIcon className="h-5 w-5 animate-spin" />
            ) : (
              <CheckIcon className="h-5 w-5" />
            )}
            {submitting ? 'Recording transaction...' : 'Record transaction'}
          </button>
          <p className="-mt-2 text-center text-xs text-slate-400">
            {canSubmit
              ? `${draft.scan.value} · ${draft.recordStatus} · ${draft.qcStatus}`
              : 'Select one Record status and one QC status to enable recording.'}
          </p>
        </div>

        {/* Right: summary + log */}
        <div className="xl:col-span-2">
          <TransactionSummary
            user={user}
            draft={draft}
            history={history}
            queuedCount={queuedCount}
            onRetrySync={handleRetrySync}
            syncing={syncing}
          />
        </div>
      </div>

      <Notification toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}