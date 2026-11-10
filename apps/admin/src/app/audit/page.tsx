'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, AuditRow } from '@/lib/api';
import { ErrorNote, Shell } from '@/components/Shell';

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ organizationId: '', action: '', dateFrom: '', dateTo: '' });
  const [applied, setApplied] = useState(filters);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setError(null);
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(applied)) if (v.trim()) qs.set(k, v.trim());
      if (cursor) qs.set('cursor', cursor);
      try {
        const res = await api<{ events: AuditRow[]; nextCursor: string | null }>(`/admin/audit-events?${qs}`);
        setRows((prev) => (cursor ? [...prev, ...res.events] : res.events));
        setNextCursor(res.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [applied],
  );

  useEffect(() => {
    load();
  }, [load]);

  const field = (key: keyof typeof filters, label: string, type = 'text') => (
    <label className="text-xs text-gray-500">
      {label}
      <input
        type={type}
        value={filters[key]}
        maxLength={100}
        onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
        className="mt-1 block rounded border px-2 py-1.5 text-sm text-gray-900"
      />
    </label>
  );

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Audit trail (all organizations)</h1>
      <p className="mb-4 text-sm text-gray-500">Viewing this page is itself recorded in the audit trail.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filters);
        }}
        className="mb-4 flex flex-wrap items-end gap-3"
      >
        {field('organizationId', 'Organization ID')}
        {field('action', 'Action')}
        {field('dateFrom', 'From', 'date')}
        {field('dateTo', 'To', 'date')}
        <button className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white">Apply</button>
      </form>
      <ErrorNote message={error} />
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Resource</th>
              <th className="px-3 py-2 font-medium">Organization</th>
              <th className="px-3 py-2 font-medium">Actor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="whitespace-nowrap px-3 py-2">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">{r.action}</td>
                <td className="px-3 py-2">
                  {r.resourceType}
                  {r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.organizationId?.slice(0, 8) ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.actorId?.slice(0, 8) ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                  No events match
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <button onClick={() => load(nextCursor)} className="mt-3 text-sm text-blue-700">
          Load more
        </button>
      )}
    </>
  );
}

export default function AuditPage() {
  return <Shell>{() => <Audit />}</Shell>;
}
