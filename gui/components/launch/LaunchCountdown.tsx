'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

interface LaunchCountdownProps {
  seconds?: number
  onComplete: () => void
}

const RADIUS = 38
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function LaunchCountdown({ seconds = 3, onComplete }: LaunchCountdownProps) {
  const [remaining, setRemaining] = useState(seconds)

  useEffect(() => {
    if (remaining <= 0) {
      onComplete()
      return
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(timer)
  }, [remaining, onComplete])

  const progress = 1 - remaining / seconds

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      className="flex flex-col items-center gap-4"
    >
      {/* SVG ring */}
      <div className="relative flex items-center justify-center">
        <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
          {/* Track */}
          <circle
            cx="48"
            cy="48"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-border"
          />
          {/* Progress arc */}
          <motion.circle
            cx="48"
            cy="48"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
            className="text-emerald-400"
            animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - progress) }}
            transition={{ duration: 0.9, ease: 'linear' }}
          />
        </svg>
        {/* Countdown number */}
        <span className="absolute font-mono text-2xl font-bold text-emerald-400">
          {remaining > 0 ? remaining : ''}
        </span>
      </div>

      <p className="text-sm text-foreground/80">
        All UAS extensions ready — <span className="font-semibold text-emerald-400">Starting UAC…</span>
      </p>
    </motion.div>
  )
}
