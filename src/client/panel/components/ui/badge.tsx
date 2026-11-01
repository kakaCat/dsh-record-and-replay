import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/12 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        success: 'border-emerald-500/25 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
        warning: 'border-amber-500/25 bg-amber-500/12 text-amber-600 dark:text-amber-400',
        destructive: 'border-red-500/25 bg-red-500/12 text-red-600 dark:text-red-400',
        info: 'border-sky-500/25 bg-sky-500/12 text-sky-600 dark:text-sky-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
  VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { badgeVariants }
