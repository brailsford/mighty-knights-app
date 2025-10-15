import '../styles/globals.css'

export const metadata = {
  title: 'Mighty Knights',
  description: 'Match console for Mighty Knights',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-white text-gray-900 dark:bg-neutral-900 dark:text-gray-100">
        <div className="mx-auto max-w-screen-xl p-4">
          {children}
        </div>
      </body>
    </html>
  )
}
