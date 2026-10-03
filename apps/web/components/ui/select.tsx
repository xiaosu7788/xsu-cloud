/**
 * 下拉选择。
 *
 * **原生 `<select>`，不是 `@radix-ui/react-select`。** 工具箱的下拉只有「从三五个固定取值里
 * 挑一个」这一种用途，原生控件在移动端会拉起系统选择器，可访问性也由浏览器保证；
 * 换成弹层实现要多带一个依赖，还得自己补键盘与读屏的边角行为。等出现「多选」「搜索」
 * 这类原生做不到的需求再换。
 *
 * 高度与错误态跟 `input.tsx` 一致：小屏 `h-11`，桌面 `md:h-10`；
 * 错误态同样走 `aria-invalid`，不引入第二套状态表达。
 *
 * `children` 由调用方给（`<option>`），本组件只负责外观与语义。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export type SelectProps = ComponentProps<'select'>;

export function Select({ className, ...props }: SelectProps) {
  return (
    <select
      data-slot="select"
      className={cn(
        'flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3',
        'text-base md:h-10 md:text-sm',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
