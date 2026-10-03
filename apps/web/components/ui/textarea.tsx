/**
 * 多行输入框。
 *
 * 与 `input.tsx` 同一套约定：小屏 44px 起步（`docs/PRD.md` 4.1 的触控目标下限）、
 * `aria-invalid` 驱动错误样式、移动端字号不低于 16px（否则 iOS 会自己缩放页面）。
 *
 * 不用 `rows` 定高而用 `min-h-32`：`rows` 是按行数算的，长内容换行后高度不变、
 * 变成内部滚动；固定最小高度配合 `auto` 的默认行为更像「一块可以长大的文本区」。
 * 调用方仍可传 `rows`，只是它不再是唯一的高度来源。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export type TextareaProps = ComponentProps<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-32 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2',
        'text-base md:text-sm',
        'placeholder:text-muted-foreground',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
