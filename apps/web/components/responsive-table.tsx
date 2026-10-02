/**
 * 宽表在移动端降级为卡片列表。
 *
 * 对应 `docs/ARCHITECTURE.md` 7.4：后台与控制台的宽表在移动端降级为卡片列表
 * （`docs/PRD.md` 4.1「列表降级卡片」）。
 *
 * ## 为什么不是「让表格横向滚动」
 *
 * 横向滚动只是把问题推给用户：一列数字要左右推着看，记不住行与列的对应关系，
 * 而且表格一滚动就顶破 360px 视口不横向滚动的红线（`docs/PRD.md` 4.1 反复强调）。
 * 卡片是纵向堆叠，天然没有横向溢出。
 *
 * ## 一份列定义驱动两种形态
 *
 * 和 `ResponsiveNav` 同一个理由：`columns` 同时是表头定义与移动端字段定义，
 * 分成两份必然漂移，而漂移只在手机上可见。
 *
 * ## 服务端组件
 *
 * 本文件没有 `'use client'`：它不持有状态，纯展示。后台列表页因此可以是服务端渲染的。
 * 表格与卡片的切换交给 CSS（`hidden md:block` / `md:hidden`），不做视口判断，
 * 服务端与首屏渲染的结构一致。
 *
 * 移动端每张卡片是「字段名 + 值」的成对展示（`<dl>`），屏幕阅读器会念出字段名；
 * 表格里靠 `<th scope="col">` 关联，两者语义都成立。
 */
import type { ReactNode } from 'react';

import { cn } from '@/components/utils';

/**
 * 一列。
 *
 * `cell` 是渲染函数而不是「取值字段名」：取值字段名只能处理 `row[key]` 这种最简单的情况，
 * 而真实表格的单元格往往是格式化后的值、状态徽章、操作按钮——那些都要拿到整行数据才能渲染。
 */
export type ResponsiveTableColumn<Row> = {
  /** 稳定标识。`columns` 的顺序变化时 React 才能正确复用节点。 */
  key: string;
  /** 表头（桌面态）。 */
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /**
   * 移动端卡片里的字段名。
   *
   * **不给就是「移动端不显示」**，不是「显示空标签」。宽表里常有一两列只在桌面有意义
   * （例如创建时间、内部 id），它们在移动端是噪声。这个默认值让「不显示」成为显式选择。
   */
  mobileLabel?: ReactNode;
  /** 移动端作为卡片标题：显示值、不显示字段名、字号更大。一张卡片**只应有一个**。 */
  primary?: boolean;
  /** 数字列右对齐（桌面态）。移动端是「名值成对」，对齐由两侧分布体现。 */
  align?: 'start' | 'end';
};

export type ResponsiveTableProps<Row> = {
  columns: readonly ResponsiveTableColumn<Row>[];
  rows: readonly Row[];
  /** 行的稳定 key。用下标会在删除行时把状态错位到相邻行上。 */
  rowKey: (row: Row) => string;
  /** 表格标题。桌面态渲染为 `<caption>`，移动端渲染为一段文字。 */
  caption?: ReactNode;
  /** 无数据时的内容。同一份内容两种形态共用。 */
  empty?: ReactNode;
  className?: string;
};

export function ResponsiveTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  className,
}: ResponsiveTableProps<Row>) {
  if (rows.length === 0 && empty) {
    return <div className={cn('text-sm text-muted-foreground', className)}>{empty}</div>;
  }

  const mobileColumns = columns.filter(
    (column) => column.primary || column.mobileLabel !== undefined,
  );

  return (
    <div className={cn('w-full', className)}>
      {/*
       * 桌面态。外层仍保留 `overflow-x-auto`：`md` 视口下遇到列数特别多的表，
       * 桌面端自己横向滚动是合理的（它不是移动端那个 360px 的场景）。
       */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          {caption ? (
            <caption className="pb-2 text-left text-sm text-muted-foreground">{caption}</caption>
          ) : null}
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-left font-medium',
                    column.align === 'end' && 'text-end',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border last:border-b-0">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn('px-3 py-2 align-top', column.align === 'end' && 'text-end')}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动态：每行一张卡。`md:hidden` 与上面互斥，任何时刻只有一种形态在可访问性树里。 */}
      <ul className="flex flex-col gap-3 md:hidden">
        {caption ? <li className="text-sm text-muted-foreground">{caption}</li> : null}
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-lg border border-border bg-card p-4">
            <dl className="flex flex-col gap-2">
              {mobileColumns.map((column) => (
                <div
                  key={column.key}
                  className={cn(
                    'flex gap-3',
                    column.primary ? 'flex-col gap-1' : 'items-baseline justify-between',
                  )}
                >
                  {column.primary ? null : (
                    <dt className="shrink-0 text-xs text-muted-foreground">{column.mobileLabel}</dt>
                  )}
                  {/* `min-w-0` 让长值（URL、邮箱）在卡片里换行而不是撑破卡片。 */}
                  <dd className={cn('min-w-0', column.primary && 'text-base font-medium')}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
