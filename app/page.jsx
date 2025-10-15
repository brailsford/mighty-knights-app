import Link from 'next/link'

export default function Home() {
  return (
    <main className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-black text-white grid place-items-center font-bold">MK</div>
        <div>
          <h1 className="text-2xl font-bold">Mighty Knights</h1>
          <p className="text-sm text-gray-500">Doncaster Knights Mini Juniors</p>
        </div>
      </header>

      <section className="rounded-3xl border p-4 shadow">
        <h2 className="text-lg font-semibold mb-2">Welcome</h2>
        <p className="text-sm mb-4">Use the Match Console to log minutes and rolling subs. This is an MVP; Supabase wiring is ready when you are.</p>
        <Link className="inline-block rounded-xl bg-blue-600 text-white px-4 py-2" href="/match">Open Match Console</Link>
      </section>
    </main>
  )
}
