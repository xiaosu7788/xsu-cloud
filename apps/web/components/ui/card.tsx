/**
 * 卡片：内容分组的默认容器。
 *
 * 拆成五个部件而不是一个 `Card` 加若干 props，是为了让每个页面的结构能直接读出来；
 * 代价是写法略长，收益是不必为「标题旁边再加一行说明」这类需求新增 props。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'flex flex-col gap-5 rounded-lg border border-border bg-card py-5 text-card-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-col gap-1.5 px-5', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('text-base font-semibold leading-tight', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex flex-wrap items-center gap-3 px-5', className)}
      {...props}
    />
  );
}
