import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DM_Sans, Space_Mono } from 'next/font/google'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StoreHydrator } from '@/components/shared/StoreHydrator'
import { EngineDiscovery } from '@/components/run/EngineDiscovery'
import './globals.css'

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  display: 'swap',
})

const spaceMono = Space_Mono({
  variable: '--font-space-mono',
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Nexus Traffic Dashboard',
  description: 'NexusTrafficTool — live SIP traffic control and monitoring',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${dmSans.variable} ${spaceMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        <StoreHydrator>
          <TooltipProvider delayDuration={300}>
            <Suspense fallback={null}>
              <EngineDiscovery />
            </Suspense>
            {children}
          </TooltipProvider>
        </StoreHydrator>
      </body>
    </html>
  )
}
