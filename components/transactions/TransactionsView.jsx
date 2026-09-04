'use client';

// ============================================================
// TransactionsView - orchestrates dual QR scanning (camera /
// scanner gun), quick status selection and transaction recording.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Notification from '@/components/Notification';
import PageHeader from '@/components/PageHeader';
import { AlertIcon, CheckIcon, SpinnerIcon } from '@/components/icons';
import { useSession } from '@/components/AppShell';
import GunScannerInput from './GunScannerInput';
import InnerBoxQrField from './InnerBoxQrField';
import ScanMethodToggle from './ScanMethodToggle';
import ScanPreview from './ScanPreview';
import StatusControls from './StatusControls';
import TransactionSummary, { StatusChip } from './TransactionSummary';
import {
  createTransaction,
  getQueuedCount,
  getRecentTransactions,
  retryQueuedTransactions,
  validateStandardTransactionScan,
  resolveOrgQrFromInnerBox,
  PACKING_UNLINKED_INNER_BOX_TITLE,
  PACKING_UNLINKED_INNER_BOX_MESSAGE,
  PACKING_LOOKUP_OFFLINE_MESSAGE,
} from '@/lib/transactionsService';
import {
  DUAL_SCAN_STAGES,
  applyDualScanScan,
  createDualScanState,
  isDualScanEnabled,
  isDualScanQcBypass,
  isFinishingDepartment,
} from '@/lib/transactionDualScan';

const CameraScanner = dynamic(() => import('./CameraScanner'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-slate-200 bg-slate-900">
      <SpinnerIcon className="h-6 w-6 animate-spin text-indigo-300" />
    </div>
  ),
});

/** localStorage key for the persistent (locked) status selection. */
const STATUS_KEY = 'tracksync.txStatuses';

export default function TransactionsView() {
  const user = useSession();
  const [method, setMethod] = useState('gun');
  // Locked workflow statuses: pre-selected once, reused for EVERY scan
  // until the user manually changes them. Persisted across reloads too.
  const [statuses, setStatuses] = useState({ record: '', qc: '' });
  const [lastScan, setLastScan] = useState(null); // { value, source, at, result }
  const [attention, setAttention] = useState(false); // flash when a scan is blocked
  const [pending, setPending] = useState(0); // auto-submissions in flight
  const [history, setHistory] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  // Dual-Scan state (Finishing departments): which scan is expected
  // next and the Inner Box QR captured in scan 1 of 2.
  const [dualScan, setDualScan] = useState(() => createDualScanState(false));
  // Bumped to make the scanner gun re-grab focus on stage changes and
  // after every recorded pair ("reset focus to the initial field").
  const [focusSignal, setFocusSignal] = useState(0);

  // Refs keep the stable scan callback free of stale closures.
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const userRef = useRef(user);
  userRef.current = user;
  const lastScanRef = useRef(null);
  lastScanRef.current = lastScan;
  const dualScanRef = useRef(dualScan);
  dualScanRef.current = dualScan;

  // Dual-Scan condition: Finishing department + QC status NOT in the
  // bypass list (B Grade / C Grade / Lab Testing). Any change of the
  // department, the QC status or the mode resets the pair and re-arms
  // focus on the initial field.
  const dualEnabled = isDualScanEnabled(user?.department, statuses.qc);
  const qcBypassed = isFinishingDepartment(user?.department) && isDualScanQcBypass(statuses.qc);
  // SPECIAL MODE: Packing Department scans ONLY the Inner Box QR - the
  // Shoe QR is resolved automatically from data_updates (no Dual-Scan
  // pair, no msk gate).
  const isPackingMode = user?.department === 'Packing';
  useEffect(() => {
    setDualScan(createDualScanState(dualEnabled));
    setFocusSignal((n) => n + 1);
  }, [dualEnabled]);

  const notify = useCallback((type, title, message) => {
    setToast({ id: Date.now(), type, title, message });
  }, []);

  // Auto-dismiss toasts after 4.5s.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Restore the locked statuses (e.g. after a page refresh mid-shift).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}');
      if (saved.record || saved.qc) setStatuses((prev) => ({ ...prev, ...saved }));
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  // Persist the locked statuses across scans AND reloads.
  useEffect(() => {
    try {
      localStorage.setItem(STATUS_KEY, JSON.stringify(statuses));
    } catch {
      /* storage unavailable - in-memory selection still works */
    }
  }, [statuses]);

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

  /* ------------------- scanning + instant auto-submit ------------------ */

  // Stable across renders so CameraScanner's captured decode callback
  // and the gun input never hold a stale closure. Fresh values come
  // from the refs above.
  const handleScan = useCallback(
    async (value, source) => {
      const code = String(value || '').trim();
      if (!code) return;

      // Ignore the same code firing again within a short window.
      const at = Date.now();
      const prev = lastScanRef.current;
      if (prev?.value === code && at - prev.at < 1500) return;

      const { record, qc } = statusesRef.current;
      if (!record || !qc) {
        // CRITICAL: never record without both statuses - prompt instead.
        setAttention(true);
        window.setTimeout(() => setAttention(false), 2200);
        notify(
          'error',
          'Scan blocked',
          'Select a Record status (IN / OUT) and a QC status first. They stay locked for every scan until you change them.'
        );
        return;
      }

      // SPECIAL MODE: Packing Department single-scan Inner Box lookup.
      // The user scans ONLY the Inner Box QR into the input field - the
      // Shoe QR (org_qr) is resolved automatically from data_updates
      // (inner_qr -> qr_code). No Dual-Scan pair is captured and the
      // msk gate is bypassed (validation runs via the pre-resolved
      // org_qr in autoSubmit).
      if (userRef.current?.department === 'Packing') {
        const lookup = await resolveOrgQrFromInnerBox(code);
        if (!lookup.found) {
          // Fail-closed: an unlinked box (or an unreachable table)
          // blocks the scan completely - nothing is written.
          setLastScan({ value: code, source: 'inner-qr', at, result: 'unlinked' });
          setAttention(true);
          window.setTimeout(() => setAttention(false), 2200);
          notify(
            'error',
            PACKING_UNLINKED_INNER_BOX_TITLE,
            lookup.offline
              ? PACKING_LOOKUP_OFFLINE_MESSAGE
              : PACKING_UNLINKED_INNER_BOX_MESSAGE
          );
          return;
        }
        // Linked box: validate + record against the resolved Shoe QR,
        // storing the scanned Inner Box QR with the transaction.
        setLastScan({ value: code, source: 'inner-qr', at, result: null });
        autoSubmit(lookup.orgQr, record, qc, code);
        return;
      }

      // Route through the Dual-Scan stage machine (a no-op pass-through
      // when Dual-Scan is disabled: bypassed QC statuses and
      // non-Finishing departments submit immediately with inner = null).
      const { next, submitCode, innerQrForSubmit } = applyDualScanScan(
        dualScanRef.current,
        code
      );

      if (!submitCode) {
        // Scan 1 of 2: Inner Box QR captured - nothing is recorded yet.
        // Shift focus to the Shoe QR field for scan 2.
        setDualScan(next);
        setFocusSignal((n) => n + 1);
        setLastScan({ value: code, source, at, result: 'inner-captured' });
        notify(
          'info',
          'Inner Box QR captured (scan 1 of 2)',
          'Now scan the Shoe QR - it validates and records the pair together.'
        );
        return;
      }

      // Scan 2 of 2 (or a single scan when bypassed): stage machine
      // already reset the pair for the next Inner Box scan.
      setDualScan(next);
      setLastScan({ value: code, source, at, result: null });
      autoSubmit(code, record, qc, innerQrForSubmit);
    },
    [notify]
  );

  async function autoSubmit(code, record, qc, innerQr = null) {
    setPending((n) => n + 1);

    // 1) Run ALL strict scan guards before anything is written:
    //      Rule 1:  msk Active-status gate -> resolves the org_qr
    //      Rule 1b: Dual-Scan Inner Box checks (V1 URL token, V2 PO
    //               match, V3 srl_num size match) when innerQr captured
    //      Rule 2:  preceding sequence net count must be exactly +1
    //      Rule 3:  prospective net count (current + scan +/-1) in [0, 1]
    //      Rule 4:  parallel same-sequence net count must be 0
    //      Rule 5:  downstream department sequence guard
    //    Any failure blocks the scan completely - amber flash + toast.
    //    `code` is the scannedQr (Shoe QR), `innerQr` is the captured Inner Box QR.
    //    In Packing mode, `code` is the already-resolved org_qr from data_updates.
    const isPackingSubmit = userRef.current?.department === 'Packing';

    // In Packing mode the `code` parameter is the RESOLVED org_qr (the
    // Shoe QR) - the value the user actually scanned is `innerQr` (the
    // Inner Box QR). The last-scan preview is keyed by the scanned
    // value, so use the correct one per mode.
    const scannedValue = isPackingSubmit ? innerQr : code;

    // In Packing mode the org_qr is pre-resolved: pass scannedQr = null
    // and the resolved org_qr (`code` here) so the msk gate is bypassed
    // and ONLY the sequence / net count / downstream guards (Rules 2-5)
    // run against the resolved org_qr.
    const scannedQrForMskLookup = isPackingSubmit ? null : code;
    
    const gate = await validateStandardTransactionScan(
      scannedQrForMskLookup,
      userRef.current,
      innerQr,
      qc,
      isPackingSubmit ? code : null
    );
    if (!gate.ok) {
      setPending((n) => Math.max(0, n - 1));
      setAttention(true);
      window.setTimeout(() => setAttention(false), 2200);
      // GLOBAL failure reset: the pair was NOT recorded, so drop the
      // captured Inner Box QR, empty the Inner Box input and re-arm
      // focus on it (stage 1) for a completely fresh scan. In bypassed
      // / single mode the state simply stays disabled and the focus
      // signal returns to the Shoe QR field.
      setDualScan(createDualScanState(dualScanRef.current.enabled));
      setFocusSignal((n) => n + 1);
      setLastScan((prev) =>
        prev && prev.value === scannedValue ? { ...prev, result: 'blocked' } : prev
      );
      notify(
        'error',
        gate.reason,
        gate.dualScan
          ? 'The Inner Box pair was rejected - both fields were cleared. Scan the Inner Box QR again.'
          : gate.offline
            ? isPackingSubmit
              ? 'A lookup table could not be reached - check your connection and try again.'
              : 'The msk table could not be reached - check your connection and try again.'
            : 'Nothing was saved for this scan. Resolve the issue above and scan again.'
      );
      return;
    }

    // 2) All guards passed - insert the standard transaction into
    //    data_updates (org_qr as qr_code, inner_qr = Inner Box QR or
    //    null for single scans).
    const result = await createTransaction(userRef.current, gate.orgQr, record, qc, innerQr);
    setPending((n) => Math.max(0, n - 1));
    setHistory((prev) => [result.row, ...prev].slice(0, 25));
    setQueuedCount(getQueuedCount());
    setLastScan((prevScan) =>
      prevScan && prevScan.value === scannedValue ? { ...prevScan, result: result.status } : prevScan
    );
    // Reset inputs/focus to the initial field for the next scan.
    setFocusSignal((n) => n + 1);
    if (result.status === 'synced') {
      notify(
        'success',
        innerQr
          ? `Recorded: ${gate.orgQr} + Inner ${innerQr} | ${record} | ${qc}`
          : `Recorded: ${gate.orgQr} | ${record} | ${qc}`,
        isPackingSubmit
          ? 'Packing transaction recorded - the Inner Box QR was resolved to its Shoe QR and stored.'
          : innerQr
            ? 'Dual-Scan pair recorded - the Inner Box QR was stored with the transaction.'
            : `MSK scan ${code} resolved via the msk table.`
      );
    } else {
      notify(
        'info',
        innerQr
          ? `Recorded on device: ${gate.orgQr} + Inner ${innerQr} | ${record} | ${qc}`
          : `Recorded on device: ${gate.orgQr} | ${record} | ${qc}`,
        result.error
      );
    }
  }

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
        subtitle="Lock in your statuses once - every scan then records instantly, hands-free"
        actions={
          <StatusChip tone={queuedCount > 0 ? 'amber' : 'emerald'}>
            {queuedCount > 0 ? `${queuedCount} queued` : 'All synced'}
          </StatusChip>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-5">
        {/* Left: scan input + status workflow */}
        <div className="flex flex-col gap-5 xl:col-span-3">
          <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                Scanning method
              </h2>
              {dualEnabled ? (
                <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">
                  Dual-Scan mode · 2 scans
                </span>
              ) : qcBypassed ? (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
                  Dual-Scan bypassed · {statuses.qc}
                </span>
              ) : null}
            </div>
            <ScanMethodToggle method={method} onChange={setMethod} />

            {/* Scan 1 of 2 - Inner Box QR (only in Dual-Scan mode). */}
            {dualEnabled ? (
              <div className="mt-5">
                <InnerBoxQrField
                  value={dualScan.innerQr}
                  awaiting={dualScan.stage === DUAL_SCAN_STAGES.INNER}
                  onClear={() => {
                    setDualScan(createDualScanState(true));
                    setFocusSignal((n) => n + 1);
                  }}
                />
              </div>
            ) : null}
            {qcBypassed ? (
              <p className="mt-5 rounded-xl bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                Dual-Scan is bypassed for “{statuses.qc}” - scan the Shoe QR only (no Inner Box QR
                is recorded).
              </p>
            ) : null}
            {isPackingMode ? (
              <p className="mt-5 rounded-xl bg-indigo-50 px-4 py-2.5 text-xs font-medium text-indigo-800 ring-1 ring-indigo-200">
                Packing single-scan mode - scan ONLY the Inner Box QR. The Shoe QR is resolved
                automatically from the recorded pair in the system.
              </p>
            ) : null}

            <div className="mt-5">
              {method === 'camera' ? (
                <CameraScanner onScan={handleScan} />
              ) : (
                <GunScannerInput
                  onScan={handleScan}
                  focusSignal={focusSignal}
                  placeholder={
                    isPackingMode
                      ? 'Scan the Inner Box QR...'
                      : dualEnabled
                        ? dualScan.stage === DUAL_SCAN_STAGES.INNER
                          ? 'Scan 1 of 2 - Inner Box QR...'
                          : 'Scan 2 of 2 - Shoe QR...'
                        : 'Scan with the gun or type a code...'
                  }
                />
              )}
            </div>
          </section>

          <StatusControls
            recordStatus={statuses.record}
            qcStatus={statuses.qc}
            attention={attention}
            onRecord={(status) => setStatuses((prev) => ({ ...prev, record: status }))}
            onQc={(status) => setStatuses((prev) => ({ ...prev, qc: status }))}
          />

          {/* Workflow status strip: readiness + live recording indicator */}
          <div
            className={`flex flex-wrap items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-center text-sm font-semibold ring-1 transition ${
              statuses.record && statuses.qc
                ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                : 'bg-amber-50 text-amber-800 ring-amber-200'
            }`}
          >
            {pending > 0 ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                Recording...
              </>
            ) : statuses.record && statuses.qc ? (
              <>
                <CheckIcon className="h-4 w-4" />
                Ready — statuses locked: {statuses.record} · {statuses.qc}. Every scan records
                instantly.
              </>
            ) : (
              <>
                <AlertIcon className="h-4 w-4" />
                Pre-select a Record status and a QC status to start scanning.
              </>
            )}
          </div>
        </div>

        {/* Right: last scan result + summary + log */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          <ScanPreview
            key={lastScan?.at || 'empty'}
            scan={lastScan}
            onClear={() => setLastScan(null)}
          />

          <TransactionSummary
            user={user}
            statuses={statuses}
            lastScan={lastScan}
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