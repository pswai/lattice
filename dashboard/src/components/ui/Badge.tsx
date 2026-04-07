import { cn } from '../../lib/utils';

interface BadgeProps {
  children: React.ReactNode;
  variant?: string;
  className?: string;
}

export function Badge({ children, variant, className }: BadgeProps) {
  return <span className={cn('badge', variant && `badge-${variant}`, className)}>{children}</span>;
}

export function RoleBadge({ role }: { role: string }) {
  return <span className={cn('role-badge', `role-${role}`)}>{role}</span>;
}

export function ScopeBadge({ scope }: { scope: string }) {
  return <span className={cn('badge', `scope-${scope}`)}>{scope}</span>;
}
