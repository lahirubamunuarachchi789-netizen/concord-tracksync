import EmptyState from '@/components/EmptyState';
import PageHeader from '@/components/PageHeader';
import { StockIcon } from '@/components/icons';

export const metadata = { title: 'Stock | Concord TrackSync' };

export default function StockPage() {
  return (
    <div className="mx-auto max-w-7xl animate-fade-slide">
      <PageHeader
        title="Stock"
        subtitle="Raw material and finished goods levels across the warehouse"
      />
      <EmptyState
        Icon={StockIcon}
        title="Stock module in preparation"
        description="Inventory tracking is being connected to the warehouse records. Live stock levels and alerts will appear here."
        items={[
          'Live material stock levels',
          'Low-stock threshold alerts',
          'Warehouse bin locations',
          'Consumption vs. wastage tracking',
        ]}
      />
    </div>
  );
}