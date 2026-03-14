'use client'

import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export function FieldError({
  error,
  className,
}: {
  error?: string
  className?: string
}) {
  if (!error) return null
  return (
    <p
      role="alert"
      className={cn('mt-0.5 flex items-center gap-1 text-xs text-rose-400', className)}
    >
      <AlertCircle className="size-3 shrink-0" />
      {error}
    </p>
  )
}

export function FieldHint({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p className={cn('mt-0.5 text-xs text-muted-foreground', className)}>{children}</p>
  )
}
