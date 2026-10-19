import type { ReactNode } from 'react'
import { CheckCircle, Info, Warning, XCircle, type Icon } from '@phosphor-icons/react'

type StatusVariant = 'error' | 'warning' | 'success' | 'info'

interface StatusBannerProps {
  variant: StatusVariant
  children: ReactNode
  className?: string
  // Set when rendered inside an always-mounted aria-live container, which does the
  // announcing — the banner then drops its own role so it isn't announced twice.
  inLiveRegion?: boolean
}

const VARIANT_CONFIG: Record<StatusVariant, { icon: Icon; classes: string }> = {
  error: {
    icon: XCircle,
    classes: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
  },
  warning: {
    icon: Warning,
    classes: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400',
  },
  success: {
    icon: CheckCircle,
    classes: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400',
  },
  info: {
    icon: Info,
    classes: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
  },
}

/** Shared status/error/warning/success/info banner — one visual convention, replaces every ad-hoc colored box. */
export function StatusBanner({ variant, children, className = '', inLiveRegion = false }: StatusBannerProps) {
  const { icon: VariantIcon, classes } = VARIANT_CONFIG[variant]
  return (
    <div
      role={inLiveRegion ? undefined : variant === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded border p-2 text-xs ${classes} ${className}`}
    >
      <VariantIcon className="mt-0.5 size-4 shrink-0" weight="bold" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}
