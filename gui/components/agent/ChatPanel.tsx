'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { X, Sparkles, Send } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'

export function ChatPanel() {
  const open = useTrafficStore((s) => s.chatPanelOpen)
  const setOpen = useTrafficStore((s) => s.setChatPanelOpen)

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ type: 'spring', damping: 26, stiffness: 300 }}
          className={cn(
            'fixed top-14 right-0 bottom-0 z-40',
            'w-[380px] border-l border-border bg-card/95 backdrop-blur-xl',
            'flex flex-col shadow-2xl shadow-black/30'
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-violet-400" />
              <span className="text-sm font-semibold text-foreground">AI Analysis</span>
              <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-400">
                Coming Soon
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Body — placeholder */}
          <div className="flex-1 flex flex-col items-center justify-center px-6 gap-4">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-violet-500/10">
              <Sparkles className="size-7 text-violet-400/60" />
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-sm font-semibold text-foreground/80">
                AI-Powered Analysis
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed max-w-[260px]">
                Ask questions about your traffic runs, get failure analysis,
                and receive optimization suggestions powered by AI.
              </p>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
              Phase 3
            </span>
          </div>

          {/* Input — disabled placeholder */}
          <div className="border-t border-border p-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 opacity-50 cursor-not-allowed">
              <input
                type="text"
                placeholder="Ask about your traffic run…"
                disabled
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
              />
              <Send className="size-4 text-muted-foreground/40" />
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
