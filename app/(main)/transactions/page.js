import EmptyState from '@/components/EmptyState';
import PageHeader from '@/components/PageHeader';
import { TransactionsIcon } from '@/components/icons';

export const metadata = { title: 'Transactions | Concord TrackSync' };

export default function TransactionsPage() {
  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Transactions"
        subtitle="Record and audit production movements across lines and departments"
      />
      <EmptyState
        Icon={TransactionsIcon}
        title="No transactions to show yet"
        description="The transactions module is being wired into the production database. Once live, every movement recorded on the floor will appear here in real time."
        items={[
          'Record production inputs & outputs',
          'Track batch movements between lines',
          'Scan-based material transfers',
          'Full movement audit trail',
        ]}
      />
    </div>
  );
}