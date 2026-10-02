/**
 * 单行输入框。
 *
 * 高度同样是 44px 起步（见 `components/ui/button.tsx` 的文件头）。
 * `aria-invalid` 驱动错误样式：不用 `.error` 这类 class，因为屏幕阅读器也要读得到
 * 这个状态，而 `aria-invalid` 是两边共用的唯一事实来源。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export type InputProps = ComponentProps<'input'>;

export function Input({ className, type, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base md:h-10 md:text-sm',
        'placeholder:text-muted-foreground',
        // 移动端 input 字号小于 16px 时 iOS 会自动放大页面，这里用 text-base 避免。
        'transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        'file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        // 浏览器自带的校验气泡与我们的错误文案会同时出现，关掉它，统一由组件渲染。
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
