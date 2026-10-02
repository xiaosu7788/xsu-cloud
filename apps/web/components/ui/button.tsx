/**
 * 按钮。
 *
 * 尺寸约定里有一条硬要求不是审美问题：`docs/PRD.md` 4.1 要求**触控目标 ≥44px**。
 * 所以每个会出现在移动端的尺寸在小屏都是 44px（`h-11`），到桌面才收到 36px（`md:h-9`）——
 * 桌面用鼠标，密度优先。`sm` 与 `default` 的区别只在更紧的内边距与更小的字号，高度一致；
 * `icon` 看着是密集尺寸，但小屏同样给到 44px（`size-11`），只是到桌面才收到 36px。
 *
 * 它同时是链接和按钮：`asChild` 时把样式交给子元素（通常是 `next/link`），
 * 避免为了「看起来像按钮的链接」复制一套 class。
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/components/utils';

const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'text-sm font-medium transition-colors',
    // 键盘焦点由 globals.css 的 :focus-visible 统一处理，这里只补一条禁用态。
    'disabled:pointer-events-none disabled:opacity-55',
    // 图标尺寸跟随字号，不要在调用点写 size-4。
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-background hover:bg-muted',
        // 次要动作用底色而不是描边，保证「有边框 = 可点击的次级操作」这一点稳定。
        ghost: 'hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      },
      size: {
        default: 'h-11 px-5 md:h-9 md:px-4',
        sm: 'h-11 px-3 text-xs md:h-9',
        lg: 'h-12 px-6 text-base',
        icon: 'size-11 md:size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** 把样式套到唯一子元素上，用于 `<Link>` 这类非 `<button>` 元素。 */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
