/**
 * 骨架块：数据到达前的占位。
 *
 * 只给一个 `animate-pulse` 的底块，尺寸由调用方用 class 决定（`h-4 w-32` 这类）。
 * 内置一组「典型尺寸」看着更省事，实际会变成「占位高度与真实内容不一致 → 数据回来时
 * 页面跳一下」，而跳动的幅度取决于每个页面的排版，组件猜不出来。
 *
 * `animate-pulse` 是 `tw-animate-css` 提供的动画（`app/globals.css` 里 `@import`
 * 该包），在 `prefers-reduced-motion: reduce` 下由那个包自己的媒体查询关掉，
 * 不需要在这里再兜一层。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
