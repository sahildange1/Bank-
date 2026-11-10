'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, OrgRow, OrgStatus } from '@/lib/api';
import { ErrorNote, Shell } from '@/components/Shell';

type Action = 'approve' | 'suspend' | 'reactivate' | 'close';

// Which actions make sense per status; the API re-validates every transition.
const ACTIONS: Record<OrgStatus, Action[]> = {
  PENDING: ['approve', 'close'],
  ACTIVE: ['suspend', 'close'],
  SUSPENDED: ['reactivate', 'close'],
  CLOSED: [],
};
const REASON_REQUIRED: Action[] = ['suspend', 'close'];
const STATUSES: OrgStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'];

function Organizations({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<OrgRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<OrgStatus | ''>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ org: OrgRow; action: Action } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setError(null);
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (search.trim()) qs.set('search', search.trim());
      if (cursor) qs.set('cursor', cursor);
      try {
        const res = await api<{ organizations: OrgRow[]; nextCursor: string | null }>(`/admin/organizations?${qs}`);
        setRows((prev) => (cursor ? [...prev, ...res.organizations] : res.organizations));
        setNextCursor(res.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [status, search],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/organizations/${pending.org.id}/${pending.action}`, {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      setPending(null);
      setReason('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Organizations</h1>
      <div className="mb-4 flex flex-wrap gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as OrgStatus | '')}
          className="rounded border bg-white px-2 py-1.5 text-sm"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name"
          maxLength={100}
          className="rounded border px-3 py-1.5 text-sm"
        />
      </div>
      <ErrorNote message={error} />
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Users</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-b last:border-0">
                <td className="px-3 py-2">{o.legalName}</td>
                <td className="px-3 py-2">{o.status}</td>
                <td className="px-3 py-2 tabular-nums">{o._count.users}</td>
                <td className="px-3 py-2">{new Date(o.createdAt).toLocaleDateString()}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  {canManage &&
                    ACTIONS[o.status].map((a) => (
                      <button
                        key={a}
                        onClick={() => {
                          setPending({ org: o, action: a });
                          setReason('');
                        }}
                        className="rounded border px-2 py-1 text-xs capitalize hover:bg-gray-50"
                      >
                        {a}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                  No organizations found
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

      {pending && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md space-y-3 rounded-lg bg-white p-5">
            <h2 className="font-semibold capitalize">
              {pending.action} {pending.org.legalName}?
            </h2>
            {(pending.action === 'suspend' || pending.action === 'close') && (
              <p className="text-sm text-gray-600">
                All of this organization&apos;s users are signed out immediately
                {pending.action === 'close' ? ', and a closed organization cannot be reopened' : ''}.
              </p>
            )}
            <label className="block text-sm">
              Reason{REASON_REQUIRED.includes(pending.action) ? ' (required)' : ' (optional)'}
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={3}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPending(null)} className="rounded border px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                onClick={confirm}
                disabled={busy || (REASON_REQUIRED.includes(pending.action) && !reason.trim())}
                className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white capitalize disabled:opacity-50"
              >
                {pending.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function OrganizationsPage() {
  return <Shell>{(me) => <Organizations canManage={me.permissions.includes('platform.organizations.manage')} />}</Shell>;
}
