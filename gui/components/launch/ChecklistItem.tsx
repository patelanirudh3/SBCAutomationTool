'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ChecklistState = 'pending' | 'checking' | 'ok' | 'failed'

export interface ChecklistItemProps {
  label: string
  state: ChecklistState
  failLog?: string
}

export function ChecklistItem({ label, state, failLog }: ChecklistItemProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        {/* Status indicator */}
        <div className="flex size-6 shrink-0 items-center justify-center">
          <AnimatePresence mode="wait">
            {state === 'pending' && (
              <motion.span
                key="pending"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                className="size-2.5 rounded-full border-2 border-muted-foreground/40"
              />
            )}

            {state === 'checking' && (
              <motion.span
                key="checking"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                className="relative flex size-5 items-center justify-center"
              >
                <svg className="size-5 animate-spin" viewBox="0 0 20 20">
                  <circle
                    cx="10"
                    cy="10"
                    r="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-muted-foreground/20"
                  />
                  <circle
                    cx="10"
                    cy="10"
                    r="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeDasharray="50.26"
                    strokeDashoffset="37.7"
                    strokeLinecap="round"
                    className="text-amber-400"
                  />
                </svg>
              </motion.span>
            )}

            {state === 'ok' && (
              <motion.span
                key="ok"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: [0, 1.25, 1] }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
              >
                <CheckCircle2 className="size-5 text-emerald-400" />
              </motion.span>
            )}

            {state === 'failed' && (
              <motion.span
                key="failed"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: [0, 1.2, 1] }}
                transition={{ duration: 0.3 }}
              >
                <XCircle className="size-5 text-rose-400" />
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Label text */}
        <span
          className={cn(
            'text-sm transition-colors duration-300',
            state === 'pending' && 'text-muted-foreground',
            state === 'checking' && 'text-amber-300',
            state === 'ok' && 'text-foreground',
            state === 'failed' && 'text-rose-300'
          )}
        >
          {label}
        </span>
      </div>

      {/* Failed log line — Space Mono per spec */}
      <AnimatePresence>
        {state === 'failed' && failLog && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="ml-9 overflow-hidden"
          >
            <p className="rounded-md bg-rose-500/10 px-3 py-1.5 font-mono text-xs text-rose-300">
              {failLog}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
