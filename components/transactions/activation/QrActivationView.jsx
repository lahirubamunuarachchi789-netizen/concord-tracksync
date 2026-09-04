'use client';

// ============================================================
// QrActivationView - QR Activation window (tab 2).
// Locks PO + Size once, then EVERY scan (gun Enter-suffix or
// camera frame) auto-activates instantly with the locked
// parameters - no submit button, hands-free continuous flow.
// Finishing departments (01-03) run the same Dual-Scan process as
// Standard Transactions: scan 1 captures the Inner Box QR, scan 2 on
// the Shoe QR validates the pair (V1 URL token, V2 PO match, V3
// srl_num size match) before the cut_qty guard and auto-activates -
// data_updates gets ALL fields incl. inner_qr, msk gets the standard
// activation marking only. Any failure resets the pair globally.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Notification from '@/components/Notification';
import PageHeader from '@/components/PageHeader';
import { AlertIcon, CheckIcon, SpinnerIcon } from '@/components/icons';
import { useSession } from '@/components/AppShell';
import GunScannerInput from '../GunScannerInput';
import InnerBoxQrField from '../InnerBoxQrField';
import ScanMethodToggle from '../ScanMethodToggle';
import ScanPreview from '../ScanPreview';
import StatusControls from '../StatusControls';
import ActivationSummary from './ActivationSummary';
import PoSelect from './PoSelect';
import SizeSelect from './SizeSelect';
import {
  buildQrCode,
  createActivation,
  evaluateCutQtyLimit,
  fetchCutQtyForPoSize,
  fetchMqcForPo,
  fetchSrlSizeForBoxCode,
  getActivatedCountSum,
  getQueuedActivationCount,
  getRecentActivations,
  innerQrExistsInDataUpdates,
  retryQueuedActivations,
} from '@/lib/qrActivationService';
import { validateActivationScan } from '@/lib/qrActivationDualScan';
import {
  DUAL_SCAN_STAGES,
  applyDualScanScan,
  createDualScanState,
  isDualScanEnabled,
  isDualScanQcBypass,
  isFinishingDepartment,
} from '@/lib/transactionDualScan';

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

  // Dual-Scan state (Finishing departments): which scan is expected
  // next and the Inner Box QR captured in scan 1 of 2.
  const [dualScan, setDualScan] = useState(() => createDualScanState(false));
  // Bumped to make the scanner gun re-grab focus on stage changes and
  // after every recorded pair ("reset focus to the initial field").
  const [focusSignal, setFocusSignal] = useState(0);
  const dualScanRef = useRef(dualScan);
  dualScanRef.current = dualScan;

  // Dual-Scan condition: Finishing department + QC status NOT in the
  // bypass list (B Grade / C Grade / Lab Testing) - identical to
  // Standard Transactions. Any change of the department, the locked QC
  // status or the mode resets the pair and re-arms focus.
  const dualEnabled = isDualScanEnabled(user?.department, params.qc);
  const qcBypassed = isFinishingDepartment(user?.department) && isDualScanQcBypass(params.qc);
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

      // Route through the Dual-Scan stage machine (a no-op pass-through
      // when Dual-Scan is disabled: bypassed QC statuses and
      // non-Finishing departments submit immediately with inner = null).
      const { next, submitCode, innerQrForSubmit } = applyDualScanScan(
        dualScanRef.current,
        code
      );

      if (!submitCode) {
        // Scan 1 of 2: Inner Box QR captured - nothing is activated yet.
        // Shift focus to the Shoe QR field for scan 2.
        setDualScan(next);
        setFocusSignal((n) => n + 1);
        setLastScan({ value: code, source, at, result: 'inner-captured' });
        notify(
          'info',
          'Inner Box QR captured (scan 1 of 2)',
          'Now scan the Shoe QR - it validates and activates the pair together.'
        );
        return;
      }

      // Scan 2 of 2 (or a single scan when bypassed): stage machine
      // already reset the pair for the next Inner Box scan.
      setDualScan(next);
      setLastScan({ value: code, source, at, result: null });
      validateAndActivate(submitCode, source, at, po, size, record, qc, innerQrForSubmit);
    },
    [notify]
  );

  /**
   * Global failure reset (identical to Standard Transactions): the
   * pair was NOT recorded, so drop any captured Inner Box QR and
   * re-arm focus on the initial field (stage 1) for a completely
   * fresh scan. In bypassed / single mode the state simply stays
   * disabled and the focus signal returns to the Shoe QR field.
   */
  function resetDualPairAfterFailure() {
    setDualScan(createDualScanState(dualScanRef.current.enabled));
    setFocusSignal((n) => n + 1);
  }

  /**
   * Validates one submit before anything is written, in this order:
   *   1. Dual-Scan Inner Box checks (V1 URL token, V2 PO match, V3
   *      srl_num size match) when an Inner Box QR was captured - a
   *      mismatched pair must never reach any other check or write.
   *   2. cut_qty limit guard - projected_total = current_sum(count) +
   *      scanCount(1, or -1 for Return) must stay within cut_qty;
   *      blocked completely (no write, amber flash, explicit toast)
   *      when the projected total would exceed cut_qty.
   * On success the record is auto-activated exactly as before.
   */
  async function validateAndActivate(code, source, at, po, size, record, qc, innerQr = null) {
    // 1. Dual-Scan pair checks. The shoe org_qr is the formatted
    //    ";mqc;po;size;scanned;" string, so V2/V3 compare against
    //    exactly the values that will be stored.
    if (innerQr) {
      const mqc = await fetchMqcForPo(po, size);
      const orgQr = buildQrCode(mqc, po, size, code);
      const gate = await validateActivationScan({
        innerQr,
        orgQr,
        getSrlSize: fetchSrlSizeForBoxCode,
        innerQrExists: innerQrExistsInDataUpdates,
        qcStatus: qc,
      });
      if (!gate.ok) {
        setAttention(true);
        window.setTimeout(() => setAttention(false), 2200);
        resetDualPairAfterFailure();
        setLastScan((prev) =>
          prev && prev.value === code ? { ...prev, result: 'blocked' } : prev
        );
        notify(
          'error',
          gate.reason,
          'The Inner Box pair was rejected - both fields were cleared. Scan the Inner Box QR again.'
        );
        return;
      }
    }

    // 2. cut_qty limit guard (reads only - nothing written yet).
    const scanCount = qc === 'Return' ? -1 : 1;
    const [cutQty, currentSum] = await Promise.all([
      fetchCutQtyForPoSize(po, size),
      getActivatedCountSum(po, size),
    ]);
    const verdict = evaluateCutQtyLimit(currentSum, cutQty, scanCount);
    setLimitInfo(verdict);
    if (!verdict.allowed) {
      // Blocked: nothing is written - flash the form and warn loudly.
      // GLOBAL reset: the pair was not recorded, start a fresh one.
      setAttention(true);
      window.setTimeout(() => setAttention(false), 2200);
      resetDualPairAfterFailure();
      setLastScan((prev) =>
        prev && prev.value === code ? { ...prev, result: 'blocked' } : prev
      );
      notify(
        'error',
        verdict.negative
          ? 'Scan blocked — Net count already at zero!'
          : 'Scan blocked — Exceeds Cut Qty limit!',
        verdict.negative
          ? 'A Return would drive the count below zero - there is nothing to return for this QR.'
          : `Current: ${verdict.currentSum}, Cut Qty: ${verdict.cutQty}. This scan was not saved.`
      );
      return;
    }
    setLastScan({ value: code, source, at, result: null });
    autoActivate(code, po, size, record, qc, innerQr);
  }

  async function autoActivate(code, po, size, record, qc, innerQr = null) {
    setPending((n) => n + 1);
    const result = await createActivation(userRef.current, code, po, size, record, qc, innerQr);
    setPending((n) => Math.max(0, n - 1));

    if (result.status === 'duplicate') {
      setLastScan((prevScan) =>
        prevScan && prevScan.value === code ? { ...prevScan, result: 'duplicate' } : prevScan
      );
      setAttention(true);
      window.setTimeout(() => setAttention(false), 2200);
      // GLOBAL reset: nothing was written - start a fresh pair.
      resetDualPairAfterFailure();
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
        innerQr
          ? `Activated: ${code} + Inner ${innerQr} | ${po} | Size ${size} | ${record} | ${qc}`
          : `Activated: ${code} | ${po} | Size ${size} | ${record} | ${qc}`,
        `${result.qrCode}${result.mqc ? ` · MQC ${result.mqc}` : ' · MQC not found'} - saved to data_updates${
          innerQr ? ' with the Inner Box QR (Dual-Scan pair)' : ''
        }.`
      );
    } else {
      notify(
        'info',
        innerQr
          ? `Activated on device: ${code} + Inner ${innerQr} | ${po} | Size ${size} | ${record} | ${qc}`
          : `Activated on device: ${code} | ${po} | Size ${size} | ${record} | ${qc}`,
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
                  Dual-Scan bypassed · {params.qc}
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
                    setDualScan(createDualScanState(dualEnabled));
                    setFocusSignal((n) => n + 1);
                  }}
                />
              </div>
            ) : null}
            {qcBypassed ? (
              <p className="mt-5 rounded-xl bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                Dual-Scan is bypassed for “{params.qc}” - scan the Shoe QR only (no Inner Box QR
                is recorded).
              </p>
            ) : null}

            <div className="mt-5">
              {method === 'camera' ? (
                <CameraScanner onScan={handleScan} />
              ) : (
                <GunScannerInput
                  onScan={handleScan}
                  paused={scanPaused}
                  focusSignal={focusSignal}
                  placeholder={
                    dualEnabled
                      ? dualScan.stage === DUAL_SCAN_STAGES.INNER
                        ? 'Scan 1 of 2 - Inner Box QR...'
                        : 'Scan 2 of 2 - Shoe QR...'
                      : 'Scan with the gun or type a code...'
                  }
                />
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