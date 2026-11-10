'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorNote, Shell } from '@/components/Shell';

type Counts = Record<string, number>;
interface Stats {
  organizations: Counts;
  users: Counts;
  payments: Counts;
}

function Card({ title, counts }: { title: string; counts: Counts }) {
  const entries = Object.entries(counts);
  return (
    <section className="rounded-lg border bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-gray-500">{title}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-400">None yet</p>
      ) : (
        <dl className="space-y-1 text-sm">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt>{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Stats>('/admin/stats').then(setStats).catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Platform overview</h1>
      <ErrorNote message={error} />
      {stats && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card title="Organizations by status" counts={stats.organizations} />
          <Card title="Users by status" counts={stats.users} />
          <Card title="Payments by status" counts={stats.payments} />
        </div>
      )}
    </>
  );
}

export default function HomePage() {
  return <Shell>{() => <Dashboard />}</Shell>;
}
