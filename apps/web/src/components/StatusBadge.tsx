import type { PaymentStatus } from '@/lib/demo-data';

const STYLE: Record<PaymentStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  REJECTED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-600',
  PROCESSING: 'bg-sky-100 text-sky-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-red-100 text-red-800',
};

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}
