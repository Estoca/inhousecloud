import * as React from 'react';
import { cn } from '../../lib/utils';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ghost' | 'outline';
  size?: 'default' | 'sm' | 'icon';
};

export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        variant === 'default' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'ghost' && 'hover:bg-accent hover:text-accent-foreground',
        variant === 'outline' && 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        size === 'default' && 'h-10 px-4 py-2',
        size === 'sm' && 'h-8 px-3',
        size === 'icon' && 'h-9 w-9',
        className,
      )}
      {...props}
    />
  );
}
