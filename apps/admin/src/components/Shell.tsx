'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, Me } from '@/lib/api';

const NAV = [
  { href: '/', label: 'Dashboard', permission: 'platform.stats.read' },
  { href: '/organizations', label: 'Organizations', permission: 'platform.organizations.read' },
  { href: '/audit', label: 'Audit trail', permission: 'platform.audit.read' },
];

/** Page frame for signed-in screens. Nav hiding is cosmetic only: the API enforces every permission. */
export function Shell({ children }: { children: (me: Me) => React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      });
  }, [router]);

  if (!me) return <main className="p-8 text-sm text-gray-500">Loading…</main>;

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Banking Admin</span>
          <nav className="flex flex-1 gap-4 text-sm">
            {NAV.filter((n) => me.permissions.includes(n.permission)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={pathname === n.href ? 'font-medium text-blue-700' : 'text-gray-600 hover:text-gray-900'}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <button onClick={signOut} className="text-sm text-gray-600 hover:text-gray-900">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children(me)}</main>
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}
