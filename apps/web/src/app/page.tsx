// Placeholder landing page. The real dashboard (balances, recent
// transactions, pending approvals, alerts — architecture §15) is built in
// Phase 6 onward, once accounts and payments exist to display.
export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Corporate Banking Platform</h1>
        <p className="mt-2 text-sm text-gray-500">Scaffolding only — dashboard not yet implemented.</p>
      </div>
    </main>
  );
}
