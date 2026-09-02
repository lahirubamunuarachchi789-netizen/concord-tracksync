'use client';

// ============================================================
// GunScannerInput - captures rapid keystrokes from USB/Bluetooth
// QR scanner guns. The field keeps focus, measures input speed
// and auto-submits when the gun fires its Enter suffix.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { QrCodeIcon, ScanLineIcon, XIcon } from '@/components/icons';

const MIN_LENGTH = 2;
/** Average ms per character below which input is treated as a machine scan. */
const SCAN_SPEED_THRESHOLD_MS = 35;

export default function GunScannerInput({ onScan }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(true);
  const [lastSource, setLastSource] = useState(null); // 'gun' | 'manual'
  const typingRef = useRef({ firstAt: 0, lastAt: 0 });

  // Keep the field armed while listening.
  useEffect(() => {
    if (listening) inputRef.current?.focus();
  }, [listening]);

  // Re-grab focus when the window regains focus (scanner stations).
  useEffect(() => {
    function handleFocus() {
      if (listening) inputRef.current?.focus();
    }
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [listening]);

  // Global capture: while armed, route stray keystrokes into the field.
  useEffect(() => {
    if (!listening) return undefined;
    function handleKey(event) {
      const el = inputRef.current;
      if (!el || event.target === el) return;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        el.focus();
        setValue((prev) => prev + event.key);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [listening]);

  function handleChange(event) {
    const now = performance.now();
    if (!typingRef.current.lastAt) typingRef.current.firstAt = now;
    typingRef.current.lastAt = now;
    setValue(event.target.value);
  }

  function submit(raw) {
    const code = raw.trim();
    if (!code || code.length < MIN_LENGTH) {
      setLastSource('manual');
      return;
    }
    // Distinguish a machine burst from typed input by average keystroke gap.
    const chars = Math.max(code.length, 2);
    const span = Math.max(typingRef.current.lastAt - typingRef.current.firstAt, 1);
    const avgGap = span / (chars - 1 || 1);
    const source = avgGap < SCAN_SPEED_THRESHOLD_MS ? 'gun' : 'manual';
    setLastSource(source);
    onScan(code, source === 'gun' ? 'gun' : 'manual');
    setValue('');
    typingRef.current = { firstAt: 0, lastAt: 0 };
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`relative rounded-2xl border-2 border-dashed p-4 transition ${
          listening ? 'border-indigo-300 bg-indigo-50/50' : 'border-slate-200 bg-slate-50'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span
              className={`h-2 w-2 rounded-full ${
                listening ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'
              }`}
            />
            {listening ? 'Listening for scanner' : 'Paused'}
          </span>
          <button
            type="button"
            onClick={() => setListening((prev) => !prev)}
            className="rounded-lg px-2.5 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {listening ? 'Pause' : 'Resume'}
          </button>
        </div>

        <div className="relative mt-3">
          <ScanLineIcon className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={!listening}
            onChange={handleChange}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit(value);
              }
            }}
            placeholder="Scan with the gun or type a code..."
            spellCheck={false}
            autoComplete="off"
            aria-label="QR scanner gun input"
            className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-11 pr-10 font-mono text-sm text-slate-900 shadow-sm outline-none transition placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-400"
          />
          {value ? (
            <button
              type="button"
              onClick={() => {
                setValue('');
                inputRef.current?.focus();
              }}
              aria-label="Clear input"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {lastSource ? (
          <p className="mt-2 text-xs text-slate-400">
            Last input detected as{' '}
            <span className="font-semibold text-slate-600">
              {lastSource === 'gun' ? 'scanner gun burst' : 'typed entry'}
            </span>
            . Auto-submits on the gun&apos;s Enter suffix.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-400">
            Fire the scanner gun anywhere on the page - keystrokes land in this field and submit
            automatically.
          </p>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-white shadow-md shadow-indigo-600/25">
          <QrCodeIcon className="h-4 w-4" />
        </span>
        <div className="text-xs leading-relaxed text-slate-500">
          <p className="font-semibold text-slate-700">Scanner gun setup</p>
          <p className="mt-0.5">
            Configure the gun in USB keyboard (HID) mode. Suffix: Enter / CR. Codes shorter than{' '}
            {MIN_LENGTH} characters are ignored to filter stray keystrokes.
          </p>
        </div>
      </div>
    </div>
  );
}