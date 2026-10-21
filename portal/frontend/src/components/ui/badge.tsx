import * as React from 'react';
import { cn } from '../../lib/utils';

type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors',
        variant === 'default' && 'border-transparent bg-primary text-primary-foreground',
        variant === 'secondary' && 'border-transparent bg-secondary text-secondary-foreground',
        variant === 'destructive' && 'border-transparent bg-destructive text-destructive-foreground',
        variant === 'outline' && 'text-foreground',
        variant === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        variant === 'warning' && 'border-amber-200 bg-amber-50 text-amber-700',
        className,
      )}
      {...props}
    />
  );
}
