'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorNote } from '@/components/Shell';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!challengeId) {
        const res = await api<{ mfaRequired: boolean; challengeId?: string }>('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        if (res.mfaRequired && res.challengeId) setChallengeId(res.challengeId);
        else router.replace('/');
      } else {
        await api('/auth/mfa/verify', { method: 'POST', body: { challengeId, code } });
        router.replace('/');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Admin sign in</h1>
        <ErrorNote message={error} />
        {!challengeId ? (
          <>
            <label className="block text-sm">
              Email
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </label>
          </>
        ) : (
          <label className="block text-sm">
            Authenticator code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2 tracking-widest"
            />
          </label>
        )}
        <button
          disabled={busy}
          className="w-full rounded bg-blue-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {challengeId ? 'Verify' : 'Continue'}
        </button>
      </form>
    </main>
  );
}
