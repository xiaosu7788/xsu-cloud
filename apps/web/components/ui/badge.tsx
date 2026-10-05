/**
 * 徽章：状态、角色、计数的短标签。
 *
 * ## 为什么单独成件
 *
 * 后台五页里「正常 / 已下架 / 已删除」「成功 / 失败」「封禁中」这些标记原先各自拼 class
 * （见 `features/admin/view.tsx` 的 `adminStatusBadge`）。三处以上同形不同色的东西一旦
 * 分开写，加一种状态就会出现「这一页圆角 4px、那一页 6px」的分叉，而这种分叉只在并排
 * 看时才发现。收成一个组件后，「有哪些状态」是文件里能数出来的。
 *
 * ## 与 `Button` 的三点不同
 *
 * 1. **不给焦点样式**。徽章默认是不可交互的 `<div>`，给它 `focus:ring-*` 是一段永远
 *    不会生效的样式；`asChild` 成链接时，焦点环由 `globals.css` 的 `:focus-visible`
 *    统一给（`docs/PRD.md` 4.1「hover 不得作为唯一反馈」的同一套处理）。
 * 2. **尺寸只有一档**。徽章嵌在表格单元格与标题行里，多一档尺寸只会多一种「和旁边
 *    文字不齐」的排版问题。
 * 3. **`success` 是硬编码色相**。语义 token 里没有「成功」这一档，而 `--primary` 是
 *    品牌色——用它表达「正常」会与主操作按钮撞色。emerald 是本项目唯一一处硬编码色相，
 *    且**没有照抄参考实现的 `text-emerald-600`**：600 号色在这层 15% 底色上只有约
 *    4.0:1，低于 AA 的 4.5（`text-xs` 属于正文尺寸），改用 700 号色（约 4.6:1）。
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground shadow',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeProps = ComponentProps<'div'> &
  VariantProps<typeof badgeVariants> & {
    /** 把样式套到唯一子元素上，用于 `<Link>` 这类非 `<div>` 元素。 */
    asChild?: boolean;
  };

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Component = asChild ? Slot : 'div';

  return (
    <Component data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
