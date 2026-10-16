import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

interface ToolbarButtonProps {
  /** The accessible name and the native tooltip. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

/** An icon button for the toolbar. Its tooltip is the native `title`: no HTML overlay may reach the web view. */
export function ToolbarButton({ label, icon: Icon, disabled, onClick }: ToolbarButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('rounded-full focus-visible:border-transparent', FOCUS_RING)}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}
