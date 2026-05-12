import type { Metadata } from 'next'
import { DM_Sans, Space_Mono } from 'next/font/google'
import { TooltipProvider } from '@/components/ui/tooltip'
import { StoreHydrator } from '@/components/shared/StoreHydrator'
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
  title: 'CCI Traffic Dashboard',
  description: 'CCIAutomationTool — live SIP traffic control and monitoring',
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
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        </StoreHydrator>
      </body>
    </html>
  )
}
