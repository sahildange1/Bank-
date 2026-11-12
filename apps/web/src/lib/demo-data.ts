// Fictional sample data for the public demo. Nothing here is real, and the
// demo never talks to a server. Amounts are integer minor units (strings).
export type PaymentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface DemoAccount { id: string; name: string; number: string; currency: string; balanceMinor: string; purpose: string }
export interface DemoPayment { id: string; beneficiary: string; reference: string; currency: string; amountMinor: string; status: PaymentStatus; maker: string; daysAgo: number }
export interface DemoNotification { id: string; title: string; body: string; minutesAgo: number; unread: boolean }

export const ORG = { name: 'Acme Trading Ltd', user: 'Priya Nair', role: 'Finance Approver' };

export const accounts: DemoAccount[] = [
  { id: 'a1', name: 'Operating account', number: '•••• 4021', currency: 'USD', balanceMinor: '48250075', purpose: 'Operating' },
  { id: 'a2', name: 'Payroll account', number: '•••• 7788', currency: 'USD', balanceMinor: '12480000', purpose: 'Payroll' },
  { id: 'a3', name: 'EU suppliers', number: '•••• 1190', currency: 'EUR', balanceMinor: '9215040', purpose: 'Operating' },
  { id: 'a4', name: 'Tax reserve', number: '•••• 3302', currency: 'GBP', balanceMinor: '3100000', purpose: 'Reserve' },
];

export const payments: DemoPayment[] = [
  { id: 'p1', beneficiary: 'Globex Manufacturing', reference: 'INV-2291', currency: 'USD', amountMinor: '1850000', status: 'PENDING_APPROVAL', maker: 'Rahul Mehta', daysAgo: 0 },
  { id: 'p2', beneficiary: 'Initech Services', reference: 'INV-2288', currency: 'USD', amountMinor: '420050', status: 'PENDING_APPROVAL', maker: 'Rahul Mehta', daysAgo: 1 },
  { id: 'p3', beneficiary: 'Stark Components', reference: 'PO-7710', currency: 'EUR', amountMinor: '9900000', status: 'PENDING_APPROVAL', maker: 'Sana Iqbal', daysAgo: 1 },
  { id: 'p4', beneficiary: 'Northwind Logistics', reference: 'FRT-0412', currency: 'USD', amountMinor: '215075', status: 'COMPLETED', maker: 'Sana Iqbal', daysAgo: 2 },
  { id: 'p5', beneficiary: 'Umbrella Retail', reference: 'INV-2270', currency: 'USD', amountMinor: '88000', status: 'PROCESSING', maker: 'Rahul Mehta', daysAgo: 2 },
  { id: 'p6', beneficiary: 'Wayne Freight', reference: 'FRT-0409', currency: 'GBP', amountMinor: '640000', status: 'COMPLETED', maker: 'Sana Iqbal', daysAgo: 4 },
  { id: 'p7', beneficiary: 'Hooli Cloud', reference: 'SUB-1105', currency: 'USD', amountMinor: '1200000', status: 'FAILED', maker: 'Rahul Mehta', daysAgo: 5 },
  { id: 'p8', beneficiary: 'Pied Piper Ltd', reference: 'INV-2251', currency: 'USD', amountMinor: '305000', status: 'REJECTED', maker: 'Sana Iqbal', daysAgo: 6 },
];

export const notifications: DemoNotification[] = [
  { id: 'n1', title: 'Approval needed', body: 'Rahul Mehta submitted a $18,500.00 payment to Globex Manufacturing.', minutesAgo: 12, unread: true },
  { id: 'n2', title: 'Payment completed', body: 'FRT-0412 to Northwind Logistics settled.', minutesAgo: 190, unread: true },
  { id: 'n3', title: 'Payment failed', body: 'SUB-1105 to Hooli Cloud was declined by the provider.', minutesAgo: 60 * 26, unread: false },
  { id: 'n4', title: 'Reconciliation clean', body: 'Ledger and account balances matched for all accounts.', minutesAgo: 60 * 30, unread: false },
];

// Account balance at close of each of the last 7 days (USD operating account), minor units.
export const balanceTrend = ['41200000', '42950000', '42100000', '45800000', '44900000', '47300000', '48250075'];
