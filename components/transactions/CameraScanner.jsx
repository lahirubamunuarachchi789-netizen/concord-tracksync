'use client';

// ============================================================
// CameraScanner - live QR scanning via html5-qrcode (client only).
// This module is loaded through next/dynamic with { ssr: false },
// so the top-level import is safe.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { CameraIcon, RefreshIcon, SpinnerIcon } from '@/components/icons';

const ELEMENT_ID = 'tracksync-qr-reader';
const CONFIG = { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 };

function friendlyError(err) {
  const raw = String(err?.message || err || '');
  if (/NotAllowed|Permission/i.test(raw))
    return 'Camera permission was denied. Allow camera access in your browser, then try again.';
  if (/NotFound|no camera/i.test(raw))
    return 'No camera was found on this device.';
  if (/secure context|https/i.test(raw))
    return 'Camera access needs a secure context. Use localhost or HTTPS.';
  return raw || 'Unable to start the camera.';
}

export default function CameraScanner({ onScan }) {
  const scannerRef = useRef(null);
  const lastScanRef = useRef({ value: '', at: 0 });
  const [cameraState, setCameraState] = useState('idle'); // idle | starting | running | error
  const [errorMsg, setErrorMsg] = useState('');

  // Clean teardown when the tab closes or the scanner unmounts.
  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;
      if (scanner) {
        scanner
          .stop()
          .then(() => scanner.clear())
          .catch(() => {});
        scannerRef.current = null;
      }
    };
  }, []);

  const handleDecode = useCallback(
    (decodedText) => {
      const value = String(decodedText || '').trim();
      if (!value) return;
      const now = Date.now();
      // Ignore the same code repeating inside the live view window.
      if (value === lastScanRef.current.value && now - lastScanRef.current.at < 1500) return;
      lastScanRef.current = { value, at: now };
      onScan(value, 'camera');
    },
    [onScan]
  );

  async function startCamera() {
    setCameraState('starting');
    setErrorMsg('');
    try {
      const scanner = new Html5Qrcode(ELEMENT_ID);
      scannerRef.current = scanner;
      await scanner.start({ facingMode: 'environment' }, CONFIG, handleDecode, () => {});
      setCameraState('running');
    } catch (err) {
      try {
        await scannerRef.current?.clear();
      } catch {
        /* ignore */
      }
      scannerRef.current = null;
      setCameraState('error');
      setErrorMsg(friendlyError(err));
    }
  }

  async function stopCamera() {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      await scanner.stop();
      scanner.clear();
    } catch {
      /* ignore */
    }
    scannerRef.current = null;
    lastScanRef.current = { value: '', at: 0 };
    setCameraState('idle');
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Live view */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-900">
        <div id={ELEMENT_ID} className="tracksync-qr-video" />
        {cameraState === 'running' ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-56 w-56">
              <span className="absolute left-0 top-0 h-8 w-8 rounded-tl-lg border-l-[3px] border-t-[3px] border-indigo-400" />
              <span className="absolute right-0 top-0 h-8 w-8 rounded-tr-lg border-r-[3px] border-t-[3px] border-indigo-400" />
              <span className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-lg border-b-[3px] border-l-[3px] border-indigo-400" />
              <span className="absolute bottom-0 right-0 h-8 w-8 rounded-br-lg border-b-[3px] border-r-[3px] border-indigo-400" />
              <span className="absolute left-1/2 top-1/2 h-0.5 w-44 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-indigo-400/70" />
            </div>
          </div>
        ) : null}

        {cameraState !== 'running' ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-indigo-200 ring-1 ring-white/15">
              {cameraState === 'starting' ? (
                <SpinnerIcon className="h-6 w-6 animate-spin" />
              ) : (
                <CameraIcon className="h-6 w-6" />
              )}
            </span>
            <p className="max-w-xs text-sm leading-relaxed text-slate-300">
              {cameraState === 'starting'
                ? 'Starting camera...'
                : cameraState === 'error'
                  ? errorMsg
                  : 'Camera is off. Start it below and point it at the QR code on the box or bundle tag.'}
            </p>
          </div>
        ) : null}
      </div>

      {cameraState === 'running' ? (
        <button
          type="button"
          onClick={stopCamera}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <RefreshIcon className="h-4 w-4" />
          Stop camera
        </button>
      ) : (
        <button
          type="button"
          onClick={startCamera}
          disabled={cameraState === 'starting'}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:shadow-indigo-600/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <CameraIcon className="h-4 w-4" />
          {cameraState === 'starting' ? 'Starting...' : 'Start camera scan'}
        </button>
      )}
      <p className="text-center text-xs text-slate-400">
        Works best on the tablet or phone mounted at the line. The same code will not fire twice
        within 1.5 seconds.
      </p>
    </div>
  );
}