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
		<header className="header-blur sticky top-0 z-40">
		  <div className="mx-auto max-w-screen-xl px-4 py-2 flex items-center justify-between gap-3">
			<div className="flex min-w-0 items-center gap-3">
			  <Image src="/mk-logo.png" alt="Mighty Knights" width={36} height={36} className="rounded" priority />
			  <div className="leading-tight min-w-0">
				<div className="font-bold tracking-tight truncate">Mighty Knights</div>
				<div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">Doncaster Knights Mini Juniors</div>
			  </div>
			</div>
			<nav className="flex items-center gap-4 text-sm overflow-x-auto no-scrollbar">
			  <Link className="hover:underline shrink-0" href="/">Home</Link>
			  <Link className="hover:underline shrink-0" href="/players">Players</Link>
			  <Link className="hover:underline shrink-0" href="/match">Match Console</Link>
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
