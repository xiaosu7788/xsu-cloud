/**
 * 空态：列表没有数据、搜索没有结果、还没有创建任何东西时的统一占位。
 *
 * ## 为什么不能只写一行「暂无数据」
 *
 * 空态是用户第一次看到某个功能的页面，它同时要回答三个问题：这里本来是干什么的
 * （`title`）、为什么现在是空的（`description`）、下一步能做什么（`action`）。
 * 只给一句「暂无数据」等于把前两个问题都丢给用户猜。
 *
 * ## 虚线边框而不是实线卡片
 *
 * 空态不是内容，用实线卡片会和真实内容混淆——用户会以为那是一张加载失败的数据卡。
 * 虚线 + 无底色表达「这里本该有东西，但现在没有」。
 *
 * `icon` 默认给 `AlertCircle`：不传图标时也不该渲染成一片空白，而「没有内容」在
 * 多数场合确实是一个需要注意的状态。传入的图标自带 `aria-hidden`（见下方写法），
 * 因为标题已经说明了状态，图标再被念一遍是重复。
 */
import { AlertCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = AlertCircle,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16 text-center">
      <Icon aria-hidden className="size-6 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
