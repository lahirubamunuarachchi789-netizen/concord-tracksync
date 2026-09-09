'use client';

// ============================================================
// QrBanManager - QR status search & ban panel (QR Activation tab).
//
// 1. SEARCH   : the user types or scans an MSK QR code into the field
//    (scanner guns type + Enter - the form submits automatically) and
//    searchMskQr() queries the msk table by the msk_qr column.
// 2. DISPLAY  : when the row's status is explicitly 'active' the PO,
//    size and style (MQC) details encoded in its org_qr are shown.
//    Banned / other statuses show the matching state instead.
// 3. BAN      : an active row offers a two-step Ban control (arm ->
//    confirm, so a stray scan cannot ban the wrong QR). Banning
//    updates msk.status -> 'ban'; from then on validateStandardScan
//    and checkActivationMskStatus reject the QR in every flow.
//
// The panel deliberately uses a plain input (not GunScannerInput):
// the activation scan field owns the global scanner-gun listener and
// only one component may capture stray keystrokes. A gun fired into
// this focused field still submits on its Enter suffix.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  QrCodeIcon,
  SpinnerIcon,
  XCircleIcon,
} from '@/components/icons';
import { banMskQr, describeMskOrgQr, searchMskQr } from '@/lib/qrBanService';
import { isActiveStatus, isBannedStatus } from '@/lib/qrBanGuard';

/** Auto-disarm window (ms) for the two-step ban confirmation. */
const CONFIRM_RESET_MS = 4000;

export default function QrBanManager({ notify = () => {} }) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null); // {found, offline, row, details}
  const [searchedValue, setSearchedValue] = useState('');
  const [banning, setBanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmTimerRef = useRef(null);

  // Auto-disarm the two-step ban confirmation.
  useEffect(() => {
    if (!confirming) return undefined;
    confirmTimerRef.current = window.setTimeout(
      () => setConfirming(false),
      CONFIRM_RESET_MS
    );
    return () => window.clearTimeout(confirmTimerRef.current);
  }, [confirming]);

  async function runSearch(rawValue) {
    const value = String(rawValue || '').trim();
    setSearchedValue(value);
    if (!value) {
      setResult({ found: false, offline: false, row: null, details: null });
      notify('info', 'Enter a QR code', 'Scan or type an MSK QR code to search the msk table.');
      return;
    }
    setSearching(true);
    setConfirming(false);
    const search = await searchMskQr(value);
    setSearching(false);
    setResult(search);
  }

  function handleSearch(event) {
    event.preventDefault();
    if (!searching && !banning) runSearch(query);
  }

  async function handleBan() {
    const row = result?.row;
    if (!row?.msk_qr) return;
    // Two-step confirmation: the first click arms the button.
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBanning(true);
    const outcome = await banMskQr(row.msk_qr);
    setBanning(false);
    if (!outcome.ok) {
      notify('error', 'Ban failed', outcome.error || 'The QR code could not be banned. Nothing was changed.');
      // Re-sync the panel with the database state after a failure.
      await runSearch(row.msk_qr);
      return;
    }
    notify(
      'success',
      'QR code banned',
      `${row.msk_qr} is now banned - it is blocked from every transaction and activation flow.`
    );
    // Refresh the panel so the banned state is shown immediately.
    await runSearch(row.msk_qr);
  }

  const row = result?.row ?? null;
  const status = row?.status ?? null;
  const active = Boolean(result?.found && isActiveStatus(status));
  const banned = Boolean(result?.found && isBannedStatus(status));

  return (
    <section className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
          QR status search &amp; ban
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">
          <QrCodeIcon className="h-3.5 w-3.5" />
          msk table
        </span>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        Scan or type an MSK QR code to check its status. Active QR codes show their PO, size and
        style details with a Ban control - a banned QR code is rejected by every transaction and
        activation flow.
      </p>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Scan or type an MSK QR code..."
          spellCheck={false}
          autoComplete="off"
          aria-label="MSK QR code search"
          className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 shadow-sm outline-none transition placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="submit"
          disabled={searching || banning}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching ? (
            <SpinnerIcon className="h-4 w-4 animate-spin" />
          ) : (
            <QrCodeIcon className="h-4 w-4" />
          )}
          Search
        </button>
      </form>

      {result && searchedValue ? (
        result.offline ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 ring-1 ring-amber-200">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            The msk table could not be reached - the status of “{searchedValue}” cannot be checked
            right now. Check the connection and try again.
          </div>
        ) : !result.found ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600 ring-1 ring-slate-200">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            No msk record found for “{searchedValue}”.
          </div>
        ) : (
          <QrBanResult
            row={row}
            details={result.details}
            active={active}
            banned={banned}
            banning={banning}
            confirming={confirming}
            onBan={handleBan}
          />
        )
      ) : null}
    </section>
  );
}

/**
 * The search result body for a FOUND msk row: status header, the
 * PO / size / style (MQC) details grid and - for active rows only -
 * the two-step Ban control.
 */
function QrBanResult({
  row,
  details,
  active,
  banned,
  banning,
  confirming,
  onBan,
}) {
  const status = row?.status ?? null;
  return (
    <div
      className={`rounded-xl px-4 py-3.5 ring-1 ${
        banned
          ? 'bg-red-50 ring-red-200'
          : active
            ? 'bg-emerald-50 ring-emerald-200'
            : 'bg-amber-50 ring-amber-200'
      }`}
    >
      {/* Status line */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
          {banned ? (
            <XCircleIcon className="h-5 w-5 text-red-600" />
          ) : active ? (
            <CheckIcon className="h-5 w-5 text-emerald-600" />
          ) : (
            <AlertCircleIcon className="h-5 w-5 text-amber-600" />
          )}
          <span className="font-mono">{row.msk_qr}</span>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${
            banned
              ? 'bg-red-100 text-red-700 ring-red-300'
              : active
                ? 'bg-emerald-100 text-emerald-700 ring-emerald-300'
                : 'bg-amber-100 text-amber-700 ring-amber-300'
          }`}
        >
          {banned ? 'Banned' : String(status ?? 'Unknown status')}
        </span>
      </div>

      {banned ? (
        <p className="mt-2.5 text-xs font-medium leading-relaxed text-red-700">
          This QR code is banned - it is completely blocked from the Standard Transaction and QR
          Activation flows. No user can enter data for it.
        </p>
      ) : (
        <QrBanDetails details={details} active={active} status={status} banning={banning} confirming={confirming} onBan={onBan} />
      )}
    </div>
  );
}

/**
 * PO / size / style (MQC) details grid - shown for every found row -
 * plus the two-step Ban control when the row is explicitly active.
 */
function QrBanDetails({ details, active, status, banning, confirming, onBan }) {
  return (
    <>
      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-white/70 px-3 py-2 ring-1 ring-slate-200">
          <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Style (MQC)
          </dt>
          <dd className="truncate font-mono text-sm font-semibold text-slate-800">
            {details?.mqc || '—'}
          </dd>
        </div>
        <div className="rounded-lg bg-white/70 px-3 py-2 ring-1 ring-slate-200">
          <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">PO</dt>
          <dd className="truncate font-mono text-sm font-semibold text-slate-800">
            {details?.po || '—'}
          </dd>
        </div>
        <div className="rounded-lg bg-white/70 px-3 py-2 ring-1 ring-slate-200">
          <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Size</dt>
          <dd className="truncate font-mono text-sm font-semibold text-slate-800">
            {details?.size || '—'}
          </dd>
        </div>
      </dl>

      {active ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onBan}
            disabled={banning}
            className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
              confirming
                ? 'bg-red-600 text-white hover:bg-red-500 focus-visible:ring-red-500'
                : 'border border-red-200 bg-white text-red-600 hover:bg-red-50 focus-visible:ring-red-400'
            }`}
          >
            {banning ? (
              <SpinnerIcon className="h-4 w-4 animate-spin" />
            ) : (
              <XCircleIcon className="h-4 w-4" />
            )}
            {banning ? 'Banning...' : confirming ? 'Confirm ban' : 'Ban this QR code'}
          </button>
          <p className="text-xs text-slate-500">
            {confirming
              ? 'Click again to confirm - this permanently blocks the QR code.'
              : 'Banning sets the msk status to “ban” and blocks all processing.'}
          </p>
        </div>
      ) : (
        <p className="mt-2.5 text-xs font-medium leading-relaxed text-amber-800">
          This QR code is not active (current status: {String(status)}), so it cannot be banned
          here - only active QR codes can be processed or banned.
        </p>
      )}
    </>
  );
}
