/**
 * 页面标题区：标题 + 一句说明 + 右侧操作。
 *
 * ## 为什么是组件而不是每页手写
 *
 * 全站有几十处「标题 + 说明」，手写的后果不是难看，而是**层级不一致**：有的页面
 * `<h1>` 是 `text-2xl`、有的是 `text-xl`，标题与说明的间距在 `space-y-1` 与 `gap-2`
 * 之间随机。标题层级是文档大纲（屏幕阅读器与搜索引擎都读它），不该由每页自由发挥。
 *
 * ## 为什么 `title` 收 `string` 而不是 `ReactNode`
 *
 * 收节点会让「标题」退化成一段任意 HTML，`<h1>` 里塞徽章、塞按钮都会出现，而
 * 那些东西的可访问名称会并进标题文本里。需要状态标记时用右侧 `actions`。
 *
 * 同一条理由不适用于 `description`：它渲染在 `<p>` 里，进不去任何可访问名称，而站内有几处
 * 说明文字中间嵌了链接（例如「公开时间线在<社区首页>」）。收 `string` 会逼这些页面在
 * 「丢掉链接」和「不用这个组件」之间二选一，两条都会让标题区重新分叉。
 *
 * ## 窄屏是纵向堆叠
 *
 * `sm` 以下标题与操作分两行：360px 下把按钮挤到标题右侧，标题会先被压成两行再换行，
 * 比直接堆叠更难看，也更难点（`docs/PRD.md` 4.1）。
 *
 * ## 不自带外边距
 *
 * 上游（DoulorCloud）这里写的是 `mb-8`。搬过来会出事：本站每个页面容器的第一层都是
 * `flex flex-col gap-6`，组件自带的 `mb-8` 会与 `gap-6` **叠加**成 56px，于是「有标题组件
 * 的页面」和「没有的页面」间距不一致，而这个组件存在的理由恰恰是统一间距。外部间距归父容器，
 * 组件只管内部排版。
 */
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
