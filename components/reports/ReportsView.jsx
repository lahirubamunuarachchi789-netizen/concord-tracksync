'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import PoSummaryView from '@/components/reports/PoSummaryView';
import DailyOutputView from '@/components/reports/DailyOutputView';
import DepartmentOutputView from '@/components/reports/DepartmentOutputView';

const TABS = [
  { id: 'po-summary', label: 'PO Summary' },
  { id: 'daily-output', label: 'Daily Output' },
  { id: 'department-output', label: 'Department Output' },
];

export default function ReportsView() {
  const [activeTab, setActiveTab] = useState(TABS[0].id);

  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Reports"
        subtitle="Production summaries and performance tracking"
      />

      {/* Tabs Navigation */}
      <div className="mb-6 border-b border-slate-200">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                whitespace-nowrap border-b-2 py-4 px-1 text-sm font-medium transition-colors
                ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">{activeTab === 'po-summary' && <PoSummaryView />}</div>
      <div className="mt-6">{activeTab === 'daily-output' && <DailyOutputView />}</div>
      <div className="mt-6">{activeTab === 'department-output' && <DepartmentOutputView />}</div>
    </div>
  );
}

function PlaceholderCard({ title, description, badges = [] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between">
        <h4 className="text-base font-semibold text-slate-900">{title}</h4>
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {badges.map((badge) => (
              <span
                key={badge}
                className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
              >
                {badge}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-600">{description}</p>
      <div className="mt-4 flex h-24 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs font-medium text-slate-400">
        Report content coming soon
      </div>
    </div>
  );
}

function PoSummaryPlaceholder() {
  return (
    <section aria-labelledby="po-summary-heading">
      <h3 id="po-summary-heading" className="text-lg font-semibold text-slate-900">
        PO Summary Report
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Purchase Order summary details, including status, quantities, and progress.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <PlaceholderCard title="PO Overview" description="High-level status of all purchase orders." badges={['Table']} />
        <PlaceholderCard title="PO Progress" description="Quantity completed vs. ordered per PO." badges={['Progress bars']} />
        <PlaceholderCard title="PO Status Breakdown" description="Open, in-progress, and closed PO counts." badges={['Chart']} />
      </div>
    </section>
  );
}


