/**
 * 表单标签。
 *
 * 不用 `@radix-ui/react-label`：本项目的表单没有「点标签切换复选框」之外的复杂需求，
 * 原生 `<label htmlFor>` 已经够用，少一个依赖就少一份升级负担。
 * 调用方**必须**让 `htmlFor` 指到真实控件的 `id`，否则点标签没有反馈——
 * 这一条没有 lint 能拦，靠 code review。
 */
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

export type LabelProps = ComponentProps<'label'>;

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm font-medium leading-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}
