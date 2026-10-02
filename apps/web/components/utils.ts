/**
 * 跨模块共享的样式工具。
 *
 * 放在 `components/` 而不是惯例里的 `lib/utils.ts`：本仓库的目录约定
 * （`AGENTS.md` 第 2 节）把 `apps/web` 的允许目录限定为
 * `app/(site|console|admin)`、`app/api`、`components`、`features`、`public`，
 * 没有 `lib`。为一个 `cn()` 新开顶层目录不划算，因此落到 `components` 根。
 *
 * 若将来引入 shadcn/ui CLI，`components.json` 的 `aliases.utils` 必须指向
 * `@/components/utils`，否则 CLI 会把新组件写成 `import { cn } from '@/lib/utils'`，
 * 而那个路径不存在。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并类名。两段各管一件事，缺一不可：
 *
 * - `clsx` 处理条件与数组写法；
 * - `twMerge` 解决「后写的同类工具类要覆盖前面的」——没有它，
 *   组件默认值 `px-4` 与调用方传入的 `px-8` 会同时出现在 class 里，
 *   谁生效取决于样式表顺序而不是书写顺序。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
