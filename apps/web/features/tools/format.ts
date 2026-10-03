/**
 * 工具箱页面的展示格式化。
 *
 * 只做「事实 → 文字」的翻译，**不含任何判定**：哪条记录能给谁看由领域层的
 * `decideToolRunAccess` 与仓储的 `user_id` 收窄决定，这里连一次查询都没有。
 *
 * ## 为什么行类型从平台层的端口推导
 *
 * 运行历史的投影类型定义在数据层（`packages/db/src/schema/tools.ts` 的 `ToolRunListItem`），
 * 而 `docs/ARCHITECTURE.md` 2.2 规定应用层不 import `@xsu/db`——平台层的端口是应用层唯一
 * 的入口。所以这里从端口返回值反推行类型：数据层的投影改字段，页面会在编译期跟着报错，
 * 不需要在表现层再抄一份字段清单，那份抄件才是真的会漂移。
 */
import { findTool, TOOL_FAILURE } from '@xsu/core';
import type { ToolPorts } from '@xsu/platform';

/** 运行历史的一行。 */
export type ToolRunRow = Awaited<ReturnType<ToolPorts['listRuns']>>[number];

/** 单条运行记录（详情页用）。 */
export type ToolRunRecord = NonNullable<Awaited<ReturnType<ToolPorts['getRun']>>>;

/** 执行结果状态。与数据层的 `TOOL_RUN_STATUSES` 同源，不在表现层重写一份。 */
export type ToolRunStatus = ToolRunRow['status'];

/**
 * slug → 工具名。
 *
 * 取不到时**原样返回 slug**而不是「未知工具」：目录在代码里（`registry.ts`），而运行历史
 * 与收藏里可以留着已下架工具的 slug（`tool_slug` 没有外键）。显示 slug 让人能直接去
 * 注册表里对账，写成「未知工具」等于把唯一的线索抹掉。
 */
export function toolDisplayName(slug: string): string {
  return findTool(slug)?.name ?? slug;
}

/**
 * 失败码 → 中文文案。
 *
 * 取不到时返回码本身：库里存的 `error_code` 是写入那一刻的快照，码表改名或那条失败分支
 * 被删掉之后，历史上这行仍然指向一个今天不存在的码。这时把码显示出来能直接定位，
 * 显示「未知错误」则什么也说明不了。
 */
export function describeFailureCode(code: string): string {
  const entry = Object.values(TOOL_FAILURE).find((failure) => failure.code === code);
  return entry ? entry.message : code;
}

/** 一行的结果描述：成功就是成功，失败给那条失败的中文文案。 */
export function describeRunStatus(status: ToolRunStatus, errorCode: string | null): string {
  if (status === 'succeeded') return '成功';
  return errorCode ? describeFailureCode(errorCode) : '失败';
}

/** 耗时。到秒就换算，避免页面上出现「12345 ms」这种要用户自己换算的数字。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 字节数。运行历史里的输入输出长度都是 UTF-8 字节数（`buildRunSummary` 的口径）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * 时间。
 *
 * 用**服务进程的时区**：机房位置是 `AGENTS.md` 第 8 节的待决项，现在把时区钉死成 UTC 或
 * +08 等于提前替用户拍板。位置定下来之后改这一处。
 */
const RUN_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function formatRunTime(date: Date): string {
  return RUN_TIME_FORMAT.format(date);
}
