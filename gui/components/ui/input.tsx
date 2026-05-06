import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Single-line input. Defaults to `w-full` so it fills its container, but the
 * cn() helper uses tailwind-merge so any width class passed via `className`
 * (e.g. "w-24" for a port, "w-44" for an IP) wins over the default. Use the
 * tightest reasonable width per field type to avoid wasting horizontal space.
 *
 * Recommended widths:
 *   port / numeric :  w-20  / w-24
 *   IP             :  w-44
 *   extension      :  w-32
 *   domain         :  w-48
 *   filesystem path:  w-full   (legitimately long)
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
