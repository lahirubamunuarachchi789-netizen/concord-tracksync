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
import ActivationSummary from './ActivationSummary';
import PoSelect from './PoSelect';
import SizeSelect from './SizeSelect';
import {
  createActivation,
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
  // Locked scan parameters: PO + size persist across scans AND reloads.
  const [params, setParams] = useState({ po: '', size: '' });
  const [lastScan, setLastScan] = useState(null);
  const [attention, setAttention] = useState(false);
  const [pending, setPending] = useState(0);
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
      if (saved.po || saved.size) setParams((prev) => ({ ...prev, ...saved }));
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
    const { flushed } = await retryQueuedActivations();
    const rows = await getRecentActivations(25);
    setHistory(rows);
    setQueuedCount(getQueuedActivationCount());
    return flushed;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const flushed = await refresh();
      if (!cancelled && flushed > 0) {
        notify('success', 'Sync complete', `${flushed} offline activation(s) uploaded.`);
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
      const flushed = await refresh();
      setSyncing(false);
      if (flushed > 0) notify('success', 'Back online', `${flushed} queued activation(s) synced.`);
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

      const { po, size } = paramsRef.current;
      if (!po || !size) {
        // CRITICAL: never activate without both parameters - prompt instead.
        setAttention(true);
        window.setTimeout(() => setAttention(false), 2200);
        notify(
          'error',
          'Scan blocked',
          'Select a Purchase Order and a Size first. They stay locked for every scan until you change them.'
        );
        return;
      }

      setLastScan({ value: code, source, at, result: null });
      autoActivate(code, po, size);
    },
    [notify]
  );

  async function autoActivate(code, po, size) {
    setPending((n) => n + 1);
    const result = await createActivation(userRef.current, code, po, size);
    setPending((n) => Math.max(0, n - 1));
    setHistory((prev) => [result.row, ...prev].slice(0, 25));
    setQueuedCount(getQueuedActivationCount());
    setLastScan((prevScan) =>
      prevScan && prevScan.value === code ? { ...prevScan, result: result.status } : prevScan
    );
    if (result.status === 'synced') {
      notify('success', `Activated: ${code} | ${po} | Size ${size}`, 'Saved to Supabase.');
    } else {
      notify('info', `Activated on device: ${code} | ${po} | Size ${size}`, result.error);
    }
  }

  async function handleRetrySync() {
    setSyncing(true);
    const flushed = await refresh();
    setSyncing(false);
    notify(
      'success',
      'Sync complete',
      flushed > 0
        ? `${flushed} queued activation(s) uploaded to Supabase.`
        : 'All activations are already up to date.'
    );
  }

  const ready = Boolean(params.po && params.size);

  return (
    <div className="animate-fade-slide">
      <PageHeader
        title="QR Activation"
        subtitle="Lock a PO and size once - every scan then activates instantly, hands-free"
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
                <GunScannerInput onScan={handleScan} />
              )}
            </div>
          </section>

          {/* Form controls directly below the scan input */}
          <PoSelect
            value={params.po}
            onChange={(po) => setParams((prev) => ({ ...prev, po }))}
            notify={notify}
          />

          <SizeSelect
            value={params.size}
            attention={attention}
            onChange={(size) => setParams((prev) => ({ ...prev, size }))}
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
                Ready — locked: {params.po} · Size {params.size}. Every scan activates instantly.
              </>
            ) : (
              <>
                <AlertIcon className="h-4 w-4" />
                Pre-select a Purchase Order and a Size to start scanning.
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