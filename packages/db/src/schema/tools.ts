/**
 * 工具箱两张表：运行历史与收藏。
 *
 * 规则（配额、归属、失败码、摘要脱敏）全在 `@xsu/core` 的 `src/tools/`，本表只负责持久化。
 *
 * **工具目录不在这里。** 一个工具 = 元数据 + 一个纯函数，目录在代码里注册
 * （`packages/core/src/tools/registry.ts`），所以 `tool_slug` **没有外键**：
 * 删掉一个工具不会清理它的历史与收藏，写入前必须由领域层校验 slug 在注册表里。
 * 理由与代价见 `docs/spec/SPEC-tools.md` 第 2 节。
 *
 * **不存原始输入输出。** 只存截断后的预览与字节数，敏感工具连预览都不存（见
 * `buildRunSummary`）。运行历史是「回看」用的，不是「重放」用的。
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { user } from './auth';

/** 一次执行的结果状态。失败也要落一行，否则「用户说失败了但我查不到」无法回答。 */
export const TOOL_RUN_STATUSES = ['succeeded', 'failed'] as const;

export type ToolRunStatus = (typeof TOOL_RUN_STATUSES)[number];

export const toolRuns = pgTable(
  'tool_runs',
  {
    id: text('id').primaryKey(),
    /** 归属（红线 6）。跨用户读取必须在领域层拒绝。 */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 工具标识。无外键，见文件头。 */
    toolSlug: text('tool_slug').notNull(),
    /**
     * 取值来自 `TOOL_RUN_STATUSES`，`enum` 选项让它在这里就带上联合类型：
     * 读出来是一个窄类型，写进去编译器会挡下未知状态，不必在仓储里强转。
     */
    status: text('status', { enum: TOOL_RUN_STATUSES }).notNull(),
    /** 失败时的稳定错误码（`@xsu/core` 的 `TOOL_FAILURE[*].code`）；成功为 null。 */
    errorCode: text('error_code'),
    /** 输入原文的字节数。**即使敏感也存长度**——长度不是内容。 */
    inputBytes: integer('input_bytes').notNull(),
    /** 输出字节数；失败或工具无输出时为 null。 */
    outputBytes: integer('output_bytes'),
    /** 领域层计时：从进入 `runTool` 到产出结果。 */
    durationMs: integer('duration_ms').notNull(),
    /** 截断后的输入预览；敏感工具为「字段名清单」，见 `buildRunSummary`。 */
    inputSummary: text('input_summary'),
    /** 截断后的输出预览；敏感工具为 null（只保留 `output_bytes`）。 */
    outputSummary: text('output_summary'),
    /** 由领域层传入的时间点（配额窗口与展示都用同一个时间点）。 */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * 一个索引服务两件事：运行历史列表（按用户取、按时间倒序）与配额窗口计数
     * （`WHERE user_id = ? AND created_at >= ?`）。两者都是「先定用户再切时间」。
     */
    index('tool_runs_user_created_idx').on(table.userId, table.createdAt),
    /**
     * 取值约束的数据库侧落点。领域层用 `TOOL_RUN_STATUSES` 做类型，这里做兜底：
     * 加状态时两处必须一起改，否则写入会被数据库拒绝（这是有意的，静默写入未知状态更糟）。
     */
    check('tool_runs_status_check', sql`${table.status} in ('succeeded', 'failed')`),
  ],
);

/**
 * 收藏表。取消收藏是**删除行**，不是置标志位：收藏没有历史语义，
 * 留一行 `favorited: false` 只会让「我的收藏」查询多一个过滤条件。
 */
export const toolFavorites = pgTable(
  'tool_favorites',
  {
    id: text('id').primaryKey(),
    /** 归属（红线 6）。 */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 工具标识。无外键，见文件头。 */
    toolSlug: text('tool_slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * 同一用户同一工具只有一条。重复收藏靠这条唯一索引挡（`ON CONFLICT DO NOTHING`），
     * 不靠「先查再插」——后者在并发下会留下两行。
     */
    uniqueIndex('tool_favorites_user_tool_idx').on(table.userId, table.toolSlug),
  ],
);

/**
 * 运行历史列表的字段投影。
 *
 * 与 `invites.ts` 的 `InviteSnapshot` 同一套做法：投影类型与投影对象放在表旁边，
 * 表现层直接引用，表结构改了而页面还按旧字段读会被编译器拦下。
 */
export type ToolRunListItem = {
  id: string;
  toolSlug: string;
  status: ToolRunStatus;
  errorCode: string | null;
  durationMs: number;
  inputBytes: number;
  createdAt: Date;
};

/** `ToolRunListItem` 对应的 select 投影。加字段时必须和上面的类型一起改。 */
export const toolRunListColumns = {
  id: toolRuns.id,
  toolSlug: toolRuns.toolSlug,
  status: toolRuns.status,
  errorCode: toolRuns.errorCode,
  durationMs: toolRuns.durationMs,
  inputBytes: toolRuns.inputBytes,
  createdAt: toolRuns.createdAt,
};

/**
 * 单条运行记录的完整投影（详情页与归属判定用）。
 *
 * 比 `ToolRunListItem` 多出 `userId`、输出侧与两个摘要：详情页要能回答
 * 「这是谁的」「当时输入输出长什么样」，列表页不需要。
 */
export type ToolRunDetail = {
  id: string;
  userId: string;
  toolSlug: string;
  status: ToolRunStatus;
  errorCode: string | null;
  inputBytes: number;
  outputBytes: number | null;
  durationMs: number;
  inputSummary: string | null;
  outputSummary: string | null;
  createdAt: Date;
};

/** `ToolRunDetail` 对应的 select 投影。加字段时必须和上面的类型一起改。 */
export const toolRunDetailColumns = {
  ...toolRunListColumns,
  userId: toolRuns.userId,
  outputBytes: toolRuns.outputBytes,
  inputSummary: toolRuns.inputSummary,
  outputSummary: toolRuns.outputSummary,
};
