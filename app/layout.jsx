import '../styles/globals.css'
import Image from 'next/image'
import Link from 'next/link'

export const metadata = {
  title: 'Mighty Knights',
  description: 'Match console for Mighty Knights',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-white text-gray-900 dark:bg-neutral-900 dark:text-gray-100">
        <header className="sticky top-0 z-40 border-b border-black/5 dark:border-white/10 bg-white/70 dark:bg-neutral-900/70 backdrop-blur">
          <div className="mx-auto max-w-screen-xl px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Image src="/mk-logo.png" alt="Mighty Knights" width={36} height={36} className="rounded" />
              <div className="leading-tight">
                <div className="font-bold">Mighty Knights</div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400">Doncaster Knights Mini Juniors</div>
              </div>
            </div>
            <nav className="flex items-center gap-4 text-sm">
              <Link className="hover:underline" href="/">Home</Link>
              <Link className="hover:underline" href="/players">Players</Link>
              <Link className="hover:underline" href="/match">Match Console</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-screen-xl p-4">{children}</main>
        <footer className="mx-auto max-w-screen-xl px-4 py-4 text-xs text-gray-500 flex items-center gap-2">
          <Image src="/dk-white.png" alt="Doncaster Knights" width={20} height={20} />
          <span>Unofficial tool for DK Mini Juniors • v0.2</span>
        </footer>
      </body>
    </html>
  )
}
