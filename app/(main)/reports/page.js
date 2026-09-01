import EmptyState from '@/components/EmptyState';
import PageHeader from '@/components/PageHeader';
import { ReportsIcon } from '@/components/icons';

export const metadata = { title: 'Reports | Concord TrackSync' };

export default function ReportsPage() {
  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Reports"
        subtitle="Production summaries and exports for every department"
      />
      <EmptyState
        Icon={ReportsIcon}
        title="Reports are coming online"
        description="We are building the reporting engine on top of the production tracking data. Scheduled and on-demand reports will be available here."
        items={[
          'Daily & weekly production summaries',
          'Department efficiency reports',
          'Export to PDF / Excel',
          'Automated email scheduling',
        ]}
      />
    </div>
  );
}