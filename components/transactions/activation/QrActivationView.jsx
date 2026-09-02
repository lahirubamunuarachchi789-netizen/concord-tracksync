'use client';

// ============================================================
// QrActivationView - QR Activation window (tab 2).
// Locks PO + Size once, then EVERY scan (gun Enter-suffix or
// camera frame) auto-activates instantly with the locked
// parameters - no submit button, hands-free continuous flow.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Notification from '@/components/Notification';
import PageHeader from '@/components/PageHeader';
import { AlertIcon, CheckIcon, SpinnerIcon } from '@/components/icons';
import { useSession } from '@/components/AppShell';
import GunScannerInput from '../GunScannerInput';
import ScanMethodToggle from '../ScanMethodToggle';
import ScanPreview from '../ScanPreview';
import StatusControls from '../StatusControls';
import ActivationSummary from './ActivationSummary';
import PoSelect from './PoSelect';
import SizeSelect from './SizeSelect';
import {
  createActivation,
  evaluateCutQtyLimit,
  fetchCutQtyForPoSize,
  getActivatedCountSum,
  getQueuedActivationCount,
  getRecentActivations,
  retryQueuedActivations,
} from '@/lib/qrActivationService';

const CameraScanner = dynamic(() => import('../CameraScanner'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-slate-200 bg-slate-900">
      <SpinnerIcon className="h-6 w-6 animate-spin text-indigo-300" />
    </div>
  ),
});

/** localStorage key for the persistent (locked) PO + size selection. */
const PARAMS_KEY = 'tracksync.activationParams';

export default function QrActivationView() {
  const user = useSession();
  const [method, setMethod] = useState('gun');
  // Pauses the global scanner-gun listener while the Add PO modal is
  // open, so typing goes to the modal input instead of the scan field.
  const [scanPaused, setScanPaused] = useState(false);
  const handleModalOpenChange = useCallback((open) => setScanPaused(Boolean(open)), []);
  // Locked scan parameters: PO, size and record/QC statuses persist
  // across scans AND reloads until the user manually changes them.
  const [params, setParams] = useState({ po: '', size: '', record: '', qc: '' });
  const [lastScan, setLastScan] = useState(null);
  const [attention, setAttention] = useState(false);
  const [pending, setPending] = useState(0);
  // Latest cut_qty guard verdict (sum / limit / projected) for the summary.
  const [limitInfo, setLimitInfo] = useState(null);
  const [history, setHistory] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  // Refs keep the stable scan callback free of stale closures.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const userRef = useRef(user);
  userRef.current = user;
  const lastScanRef = useRef(null);
  lastScanRef.current = lastScan;

  const notify = useCallback((type, title, message) => {
    setToast({ id: Date.now(), type, title, message });
  }, []);

  // Auto-dismiss toasts after 4.5s.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Restore locked parameters (e.g. after a page refresh mid-shift).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}');
      if (saved.po || saved.size || saved.record || saved.qc) {
        setParams((prev) => ({ ...prev, ...saved }));
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  // Persist locked parameters across scans AND reloads.
  useEffect(() => {
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
    } catch {
      /* storage unavailable - in-memory selection still works */
    }
  }, [params]);

  /* ------------------------- initial load -------------------------- */

  const refresh = useCallback(async () => {
    const { flushed, skipped } = await retryQueuedActivations();
    const rows = await getRecentActivations(25);
    setHistory(rows);
    setQueuedCount(getQueuedActivationCount());
    return { flushed, skipped };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { flushed, skipped } = await refresh();
      if (!cancelled && (flushed > 0 || skipped > 0)) {
        notify(
          'success',
          'Sync complete',
          `${flushed} offline activation(s) uploaded${
            skipped > 0 ? `, ${skipped} duplicate(s) skipped` : ''
          }.`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, notify]);

  // Auto-retry the queue when connectivity returns.
  useEffect(() => {
    async function retry() {
      setSyncing(true);
      const { flushed, skipped } = await refresh();
      setSyncing(false);
      if (flushed > 0 || skipped > 0) {
        notify(
          'success',
          'Back online',
          `${flushed} queued activation(s) synced${
            skipped > 0 ? `, ${skipped} duplicate(s) skipped` : ''
          }.`
        );
      }
    }
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [refresh, notify]);

  /* ------------------ scanning + instant activation ---------------- */

  // Stable across renders so the camera decode callback and the gun
  // input never hold a stale closure. Fresh values come from refs.
  const handleScan = useCallback(
    (value, source) => {
      const code = String(value || '').trim();
      if (!code) return;

      // Ignore the same code firing again within a short window.
      const at = Date.now();
      const prev = lastScanRef.current;
      if (prev?.value === code && at - prev.at < 1500) return;

      const { po, size, record, qc } = paramsRef.current;
      // CRITICAL: never activate with incomplete parameters - prompt instead.
      const missing = [];
      if (!po) missing.push('Purchase Order');
      if (!size) missing.push('Size');
      if (!record) missing.push('Record Status');
      if (!qc) missing.push('QC Status');
      if (missing.length > 0) {
        setAttention(true);
        window.setTimeout(() => setAttention(false), 2200);
        notify(
          'error',
          'Scan blocked',
          `Missing: ${missing.join(', ')}. Locked selections apply to every scan until you change them.`
        );
        return;
      }

      // cut_qty limit guard runs before any insert; on success the
      // record is inserted exactly as before.
      validateAndActivate(code, source, at, po, size, record, qc);
    },
    [notify]
  );

  /**
   * Validates the scan against the pod cut_qty limit, then activates.
   * projected_total = current_sum(count) + scanCount(1, or -1 for Return);
   * blocked completely (no write, amber flash, explicit toast) when the
   * projected total would exceed cut_qty.
   */
  async function validateAndActivate(code, source, at, po, size, record, qc) {
    const scanCount = qc === 'Return' ? -1 : 1;
    const [cutQty, currentSum] = await Promise.all([
      fetchCutQtyForPoSize(po, size),
      getActivatedCountSum(po, size),
    ]);
    const verdict = evaluateCutQtyLimit(currentSum, cutQty, scanCount);
    setLimitInfo(verdict);
    if (!verdict.allowed) {
      // Blocked: nothing is written - flash the form and warn loudly.
      setAttention(true);
      window.setTimeout(() => setAttention(false), 2200);
      notify(
        'error',
        'Scan blocked — Exceeds Cut Qty limit!',
        `Current: ${verdict.currentSum}, Cut Qty: ${verdict.cutQty}. This scan was not saved.`
      );
      return;
    }
    setLastScan({ value: code, source, at, result: null });
    autoActivate(code, po, size, record, qc);
  }

  async function autoActivate(code, po, size, record, qc) {
    setPending((n) => n + 1);
    const result = await createActivation(userRef.current, code, po, size, record, qc);
    setPending((n) => Math.max(0, n - 1));

    if (result.status === 'duplicate') {
      setLastScan((prevScan) =>
        prevScan && prevScan.value === code ? { ...prevScan, result: 'duplicate' } : prevScan
      );
      setAttention(true);
      window.setTimeout(() => setAttention(false), 2200);
      notify(
        'error',
        'Scan blocked — QR code has already been activated!',
        'Duplicate org_qr found. Nothing was written to data_updates or msk.'
      );
      return;
    }

    setHistory((prev) => [result.row, ...prev].slice(0, 25));
    setQueuedCount(getQueuedActivationCount());
    setLastScan((prevScan) =>
      prevScan && prevScan.value === code ? { ...prevScan, result: result.status } : prevScan
    );
    if (result.status === 'synced') {
      notify(
        'success',
        `Activated: ${code} | ${po} | Size ${size} | ${record} | ${qc}`,
        `${result.qrCode}${result.mqc ? ` · MQC ${result.mqc}` : ' · MQC not found'} - saved to data_updates.`
      );
    } else {
      notify(
        'info',
        `Activated on device: ${code} | ${po} | Size ${size} | ${record} | ${qc}`,
        `${result.qrCode} · ${result.error}`
      );
    }
  }

  async function handleRetrySync() {
    setSyncing(true);
    const { flushed, skipped } = await refresh();
    setSyncing(false);
    notify(
      'success',
      'Sync complete',
      flushed > 0 || skipped > 0
        ? `${flushed} queued activation(s) uploaded to Supabase${
            skipped > 0 ? `, ${skipped} duplicate(s) skipped` : ''
          }.`
        : 'All activations are already up to date.'
    );
  }

  const ready = Boolean(params.po && params.size && params.record && params.qc);

  return (
    <div className="animate-fade-slide">
      <PageHeader
        title="QR Activation"
        subtitle="Lock PO, size & statuses once - every scan then activates instantly, hands-free"
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-5">
        {/* Left: scanning + locked parameters */}
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
                <GunScannerInput onScan={handleScan} paused={scanPaused} />
              )}
            </div>
          </section>

          {/* Form controls directly below the scan input */}
          <PoSelect
            value={params.po}
            onChange={(po) => setParams((prev) => ({ ...prev, po }))}
            notify={notify}
            onModalOpenChange={handleModalOpenChange}
          />

          <SizeSelect
            value={params.size}
            attention={attention}
            onChange={(size) => setParams((prev) => ({ ...prev, size }))}
          />

          {/* Record & QC status - same components/styling as Standard
              Transactions. Selections stay locked with the PO + size. */}
          <StatusControls
            recordStatus={params.record}
            qcStatus={params.qc}
            attention={attention}
            onRecord={(record) => setParams((prev) => ({ ...prev, record }))}
            onQc={(qc) => setParams((prev) => ({ ...prev, qc }))}
          />

          {/* Workflow status strip: readiness + live activation indicator */}
          <div
            className={`flex flex-wrap items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-center text-sm font-semibold ring-1 transition ${
              ready
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                : 'bg-amber-50 text-amber-800 ring-amber-200'
            }`}
          >
            {pending > 0 ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                Activating...
              </>
            ) : ready ? (
              <>
                <CheckIcon className="h-4 w-4" />
                Ready — locked: {params.po} · Size {params.size} · {params.record} ·{' '}
                {params.qc}. Every scan activates instantly.
              </>
            ) : (
              <>
                <AlertIcon className="h-4 w-4" />
                Pre-select a Purchase Order, Size, Record status and QC status to start scanning.
              </>
            )}
          </div>
        </div>

        {/* Right: preview + summary + log */}
        <div className="flex flex-col gap-5 xl:col-span-2">
          <ScanPreview
            key={lastScan?.at || 'empty'}
            scan={lastScan}
            onClear={() => setLastScan(null)}
          />
          <ActivationSummary
            user={user}
            params={params}
            limitInfo={limitInfo}
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