import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { CircleNotch } from '@phosphor-icons/react'

type ButtonVariant = 'primary' | 'secondary' | 'destructive'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  loading?: boolean
  children: ReactNode
  ref?: Ref<HTMLButtonElement>
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300 dark:disabled:bg-slate-700 dark:disabled:text-slate-400',
  secondary:
    'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  destructive:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:bg-red-500 dark:hover:bg-red-600 dark:disabled:bg-red-900',
}

/** Shared button primitive — variant styling, loading spinner, focus ring, 44px min touch target. */
export function Button({ variant = 'primary', loading = false, disabled, className = '', children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed dark:focus-visible:outline-blue-400 ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {loading && (
        <CircleNotch className="size-4 animate-spin motion-reduce:animate-none" weight="bold" aria-hidden="true" />
      )}
      {children}
    </button>
  )
}
