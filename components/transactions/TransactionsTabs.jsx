'use client';

// ============================================================
// TransactionsTabs - top-level view switcher on /transactions:
//  * Standard Transactions (existing status workflow)
//  * QR Activation (PO + size locked scanning window)
// Only the active view is mounted so the scanner-gun global
// keystroke capture never runs twice at once.
// ============================================================

import { useState } from 'react';
import { BoltIcon, ScanLineIcon } from '@/components/icons';
import TransactionsView from './TransactionsView';
import QrActivationView from './activation/QrActivationView';

const TABS = [
  {
    id: 'standard',
    label: 'Standard Transactions',
    hint: 'Scan → status → auto record',
    Icon: ScanLineIcon,
  },
  {
    id: 'activation',
    label: 'QR Activation',
    hint: 'Scan → PO + size → auto activate',
    Icon: BoltIcon,
  },
];

export default function TransactionsTabs() {
  const [tab, setTab] = useState('standard');

  return (
    <div className="mx-auto max-w-7xl">
      {/* View switcher */}
      <div
        role="tablist"
        aria-label="Transactions view"
        className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {TABS.map(({ id, label, hint, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={`group flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                active
                  ? 'border-transparent bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white shadow-lg shadow-indigo-600/25'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/40'
              }`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  active
                    ? 'bg-white/15 ring-1 ring-white/25'
                    : 'bg-slate-100 text-slate-500 group-hover:bg-white group-hover:text-indigo-600'
                }`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{label}</span>
                <span
                  className={`block truncate text-xs ${active ? 'text-indigo-100' : 'text-slate-400'}`}
                >
                  {hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'standard' ? <TransactionsView /> : <QrActivationView />}
    </div>
  );
}