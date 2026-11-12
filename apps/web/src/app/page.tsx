'use client';

import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/StatusBadge';
import { accounts, balanceTrend, DemoPayment, notifications, ORG, payments as seedPayments } from '@/lib/demo-data';
import { formatMinor, sumMinor } from '@/lib/money';

function ago(minutes: number) {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border bg-white p-4 ${className}`}>
      <h2 className="mb-3 text-sm font-medium text-gray-500">{title}</h2>
      {children}
    </section>
  );
}

function TrendChart() {
  const values = balanceTrend.map((v) => Number(BigInt(v) / 100n)); // display scaling only; money math stays BigInt
  const max = Math.max(...values); // zero baseline: bar heights are proportional to the balance
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <svg viewBox="0 0 280 110" role="img" aria-label="Operating account balance, last 7 days" className="w-full">
      {values.map((v, i) => {
        const h = (v / (max || 1)) * 76;
        return (
          <g key={i}>
            <rect x={8 + i * 39} y={90 - h} width="28" height={h} rx="3" className={i === values.length - 1 ? 'fill-blue-600' : 'fill-blue-200'} />
            <text x={22 + i * 39} y="106" textAnchor="middle" className="fill-gray-500 text-[9px]">{days[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const [payments, setPayments] = useState<DemoPayment[]>(seedPayments);
  const [toast, setToast] = useState<string | null>(null);

  const pending = payments.filter((p) => p.status === 'PENDING_APPROVAL');
  const totals = useMemo(() => {
    const byCurrency = new Map<string, string[]>();
    accounts.forEach((a) => byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a.balanceMinor]));
    return [...byCurrency].map(([c, v]) => ({ currency: c, total: sumMinor(v) }));
  }, []);

  function decide(p: DemoPayment, approve: boolean) {
    // Mirrors the real rule: the maker cannot approve their own payment. (Demo user is not a maker here.)
    setPayments((all) => all.map((x) => (x.id === p.id ? { ...x, status: approve ? 'APPROVED' : 'REJECTED' } : x)));
    setToast(`${p.reference} ${approve ? 'approved' : 'rejected'} (demo only — nothing was sent)`);
    setTimeout(() => setToast(null), 3500);
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">
        <strong>Demo with fictional sample data.</strong> Sandbox platform — no real money, no backend connected.
      </div>
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Corporate Banking</span>
          <nav className="hidden flex-1 gap-4 text-sm sm:flex">
            <span className="font-medium text-blue-700">Dashboard</span>
            <span className="text-gray-400">Accounts</span>
            <span className="text-gray-400">Payments</span>
            <span className="text-gray-400">Approvals</span>
          </nav>
          <div className="ml-auto text-right text-xs leading-tight">
            <div className="font-medium">{ORG.user}</div>
            <div className="text-gray-500">{ORG.name} · {ORG.role}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <h1 className="text-xl font-semibold">Good morning, {ORG.user.split(' ')[0]}</h1>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {totals.map((t) => (
            <Card key={t.currency} title={`Total balance · ${t.currency}`}>
              <p className="text-2xl font-semibold tabular-nums">{formatMinor(t.total, t.currency)}</p>
            </Card>
          ))}
          <Card title="Awaiting your approval">
            <p className="text-2xl font-semibold tabular-nums">{pending.length}</p>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Accounts" className="lg:col-span-2">
            <ul className="divide-y text-sm">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-gray-500">{a.number} · {a.purpose}</div>
                  </div>
                  <div className="tabular-nums font-medium">{formatMinor(a.balanceMinor, a.currency)}</div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Operating balance · 7 days">
            <TrendChart />
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Approval queue" className="lg:col-span-1">
            {pending.length === 0 ? (
              <p className="text-sm text-gray-400">Nothing waiting.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {pending.map((p) => (
                  <li key={p.id} className="rounded border p-3">
                    <div className="flex justify-between">
                      <span className="font-medium">{p.beneficiary}</span>
                      <span className="tabular-nums">{formatMinor(p.amountMinor, p.currency)}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500">{p.reference} · made by {p.maker}</div>
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => decide(p, true)} className="rounded bg-blue-700 px-3 py-1 text-xs text-white hover:bg-blue-800">Approve</button>
                      <button onClick={() => decide(p, false)} className="rounded border px-3 py-1 text-xs hover:bg-gray-50">Reject</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent payments" className="overflow-x-auto lg:col-span-2">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr><th className="pb-2 font-medium">Beneficiary</th><th className="pb-2 font-medium">Reference</th><th className="pb-2 text-right font-medium">Amount</th><th className="pb-2 pl-4 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2">{p.beneficiary}</td>
                    <td className="py-2 text-gray-500">{p.reference}</td>
                    <td className="py-2 text-right tabular-nums">{formatMinor(p.amountMinor, p.currency)}</td>
                    <td className="py-2 pl-4"><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <Card title="Notifications">
          <ul className="divide-y text-sm">
            {notifications.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-2">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.unread ? 'bg-blue-600' : 'bg-transparent'}`} aria-label={n.unread ? 'unread' : 'read'} />
                <div className="flex-1"><span className="font-medium">{n.title}.</span> <span className="text-gray-600">{n.body}</span></div>
                <span className="shrink-0 text-xs text-gray-400">{ago(n.minutesAgo)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </main>

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded bg-gray-900 px-4 py-2 text-sm text-white shadow">{toast}</div>
      )}
    </div>
  );
}
