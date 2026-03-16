'use client'

import { AlertCircle, AlertTriangle } from 'lucide-react'
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

export function FieldSoftWarning({
  warning,
  className,
}: {
  warning?: string
  className?: string
}) {
  if (!warning) return null
  return (
    <p
      className={cn('mt-0.5 flex items-center gap-1 text-xs text-amber-400', className)}
    >
      <AlertTriangle className="size-3 shrink-0" />
      {warning}
    </p>
  )
}

export function FieldWarning({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        'mt-1 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 text-xs text-amber-300',
        className
      )}
    >
      <AlertTriangle className="mt-px size-3 shrink-0" />
      <span>{children}</span>
    </p>
  )
}
