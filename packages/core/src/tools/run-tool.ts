/**
 * 工具执行的领域规则：目录查找 → 输入校验 → 配额 → 执行 → 落历史。
 *
 * 顺序是规则的一部分，不能重排（`docs/spec/SPEC-tools.md` 第 4 节）：
 *
 * 1. 工具不存在 → `toolNotFound`，**不落历史**（无法归属到一个工具）；
 * 2. 输入不合法 → `inputInvalid` / `inputTooLarge`，**落一行失败历史**；
 * 3. 超配额 → `quotaExceeded`，**不落历史**。否则被拒也会计数，越拒越容易再被拒；
 * 4. 执行抛错 → 用户能修的（`ToolInputError`）是 `inputInvalid`，其余是 `runFailed` 并挂 `cause`；
 * 5. 成功与执行失败都落一行，**先落历史再返回结果**，因此「有结果必有记录」。
 *
 * 领域层不写日志、不组装 HTTP 响应：`TOOL_FAILURE` 只给状态码与文案，怎么用由应用层决定。
 */
import type { ToolRunStatus } from '@xsu/db/schema';

import { findTool } from './registry';
import { type ToolDefinition, type ToolInput, ToolInputError, type ToolOutput } from './types';

/** 单位时间（1 小时）内单用户最多执行多少次。配置缺省时用它。 */
export const TOOL_QUOTA_PER_HOUR_DEFAULT = 30;

/**
 * 运行历史的保留天数。配置缺省时用它。
 *
 * 这是一个**默认值，不是容量评估的结论**（`docs/spec/SPEC-tools.md` 已知债务）：按现在的量级
 * 一年也攒不满一次清理，定哪个数都行，所以先给一个「够回看、不会无限长」的数字。
 * 真正决定它的是磁盘成本与合规要求，那要等有真实数据再说。
 */
export const TOOL_RUN_RETENTION_DAYS_DEFAULT = 30;

/** 配额窗口长度。改这里等于改「单位时间」的定义。 */
export const TOOL_QUOTA_WINDOW_MS = 60 * 60 * 1000;

/** 单次请求所有字段值合计的字节上限（64 KiB）。单字段另有 `maxLength` 的字符数上限。 */
export const TOOL_RUN_MAX_INPUT_BYTES = 65536;

/** 非敏感工具的输入预览长度。够回看是哪次调用，不够还原原文。 */
export const TOOL_RUN_INPUT_PREVIEW_CHARS = 120;

/** 非敏感工具的输出预览长度。比输入长一些，因为输出常是要复制走的结果。 */
export const TOOL_RUN_OUTPUT_PREVIEW_CHARS = 500;

/**
 * 失败码表（全站唯一来源）。
 *
 * 与 `ACCESS_DENIED` 同一套形状：`status` 与 `code` 给应用层组装响应，`message` 给用户看。
 * 新增失败原因加在这里，**不要在调用点就地造文案**——否则同一件事会出现两种说法。
 */
export const TOOL_FAILURE = {
  /** slug 不在注册表里。 */
  toolNotFound: {
    status: 404,
    code: 'TOOL_NOT_FOUND',
    message: '没有这个工具。',
  },
  /** 必填字段为空、下拉取值非法，或工具判定输入语义有误。 */
  inputInvalid: {
    status: 400,
    code: 'TOOL_INPUT_INVALID',
    message: '输入不完整或格式不正确。',
  },
  /** 单字段或整体超出长度上限。 */
  inputTooLarge: {
    status: 400,
    code: 'TOOL_INPUT_TOO_LARGE',
    message: '输入过长，请精简后重试。',
  },
  /** 单位时间内的执行次数达到上限。 */
  quotaExceeded: {
    status: 429,
    code: 'TOOL_QUOTA_EXCEEDED',
    message: '执行太频繁了，请稍后再试。',
  },
  /** 工具函数抛出未预期的错误。 */
  runFailed: {
    status: 500,
    code: 'TOOL_RUN_FAILED',
    message: '工具执行失败，请稍后重试。',
  },
  /** 这条运行记录不属于当前账号。 */
  runForbidden: {
    status: 403,
    code: 'TOOL_RUN_FORBIDDEN',
    message: '这条运行记录不属于当前账号。',
  },
} as const;

export type ToolFailureCode = keyof typeof TOOL_FAILURE;

/** 失败码表里的一项。 */
export type ToolFailureEntry = (typeof TOOL_FAILURE)[ToolFailureCode];

/** 带上下文的失败：`field` 指出是哪个字段（表单可以据此高亮），`cause` 只用于记日志。 */
export type ToolFailure = ToolFailureEntry & { field?: string; cause?: unknown };

const encoder = new TextEncoder();

/** UTF-8 字节数。长度口径全站一致：摘要、上限、`input_bytes` 都用它。 */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 按码点数（`[...text].length`），不按 UTF-16 码元，否则 emoji 会被算成两个字符。 */
function charLength(text: string): number {
  return [...text].length;
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

/**
 * 把提交上来的原始输入归一成「声明过的字段都存在」的形状。
 *
 * 未提交与提交空字符串**归一后没有区别**（都是 `''`）。可选字段本来就允许留空，
 * 必填字段留空会在下面被判为 `inputInvalid`，所以这里不需要区分两者。
 */
function normalizeToolInput(tool: ToolDefinition, input: ToolInput): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of tool.fields) {
    const raw = input[field.name];
    values[field.name] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

/**
 * 机械校验：必填 → 下拉取值 → 单字段长度 → 整体长度。返回第一个不通过的原因。
 *
 * 导出而不是留在内部，是为了让「整体长度」那一档可测：现有四个内置工具单字段最多
 * 20000 字符，凑不到 64 KiB 的合计上限，只有代入一个人造的工具定义才能覆盖这条分支。
 * 入参可以是原始输入——未提交的字段在这里与空字符串等价。
 */
export function checkToolInput(tool: ToolDefinition, input: ToolInput): ToolFailure | null {
  for (const field of tool.fields) {
    const value = input[field.name] ?? '';

    if (field.required && value.trim() === '') {
      return { ...TOOL_FAILURE.inputInvalid, field: field.name };
    }

    if (field.kind === 'select' && value !== '') {
      const allowed = field.options?.some((option) => option.value === value) ?? false;
      if (!allowed) {
        return { ...TOOL_FAILURE.inputInvalid, field: field.name };
      }
    }

    if (charLength(value) > field.maxLength) {
      return { ...TOOL_FAILURE.inputTooLarge, field: field.name };
    }
  }

  const totalBytes = tool.fields.reduce(
    (sum, field) => sum + byteLength(input[field.name] ?? ''),
    0,
  );
  if (totalBytes > TOOL_RUN_MAX_INPUT_BYTES) {
    return TOOL_FAILURE.inputTooLarge;
  }

  return null;
}

/** 运行历史里要落的那部分内容。 */
export type ToolRunSummary = {
  inputBytes: number;
  outputBytes: number | null;
  inputSummary: string | null;
  outputSummary: string | null;
};

/**
 * 运行历史的摘要与脱敏。**截断与脱敏的唯一实现就是这里**，页面与仓储都不许自己截。
 *
 * - `sensitive: false`：存截断后的输入（`字段=值` 拼起来）与输出。
 * - `sensitive: true`：输入只存**字段名**，输出一个字符都不存；长度由 `inputBytes` /
 *   `outputBytes` 表示。理由见 `docs/PRD.md` 3.3 验收 2——运行历史不能变成口令仓库。
 */
export function buildRunSummary(params: {
  tool: ToolDefinition;
  input: Record<string, string>;
  output: ToolOutput | null;
}): ToolRunSummary {
  const { tool, input, output } = params;
  const fields = tool.fields.map((field) => ({
    name: field.name,
    value: input[field.name] ?? '',
  }));
  const inputBytes = fields.reduce((sum, field) => sum + byteLength(field.value), 0);
  const outputBytes = output ? byteLength(output.text) : null;

  if (tool.sensitive) {
    const names = fields.filter((field) => field.value !== '').map((field) => field.name);
    return {
      inputBytes,
      outputBytes,
      inputSummary: names.length > 0 ? `[已脱敏] 字段：${names.join('、')}` : null,
      outputSummary: null,
    };
  }

  return {
    inputBytes,
    outputBytes,
    inputSummary: truncate(
      fields.map((field) => `${field.name}=${field.value}`).join(' '),
      TOOL_RUN_INPUT_PREVIEW_CHARS,
    ),
    outputSummary: output ? truncate(output.text, TOOL_RUN_OUTPUT_PREVIEW_CHARS) : null,
  };
}

/** 落一行运行历史所需的字段。数据层的 `NewToolRun` 与它逐字段对齐。 */
export type ToolRunRecord = {
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

/**
 * 「怎么做」的抽象：目录查找以外的所有外部能力。
 *
 * `now` 由外部注入而不是直接 `new Date()`：配额窗口与耗时都要能被测试固定在一个时间点上，
 * 与 `packages/core/src/invites.ts` 依赖调用方传入时间点是同一条约定。
 */
export type ToolRunPorts = {
  now: () => Date;
  newRunId: () => string;
  countRunsSince: (params: { userId: string; since: Date }) => Promise<number>;
  recordRun: (run: ToolRunRecord) => Promise<void>;
  /** 单位时间配额上限，来自配置；**为 0 表示关闭执行**（不是「不限」）。 */
  quotaPerHour: number;
};

export type ToolRunOutcome =
  | { ok: true; runId: string; output: ToolOutput; durationMs: number }
  | { ok: false; failure: ToolFailure };

/**
 * 这条运行记录该不该给这个人看。
 *
 * **只有归属者放行，管理员也不放行**：`docs/PRD.md` 3.3 验收 4 是「用户只能看到自己的
 * 运行历史」，后台查看他人历史属于 M5，且必须带审计日志。数据层的查询也按 `user_id`
 * 收窄，两处是有意的重复（纵深防御）。
 */
export function decideToolRunAccess(params: {
  viewerId: string;
  ownerId: string;
}): { allowed: true } | { allowed: false; failure: ToolFailure } {
  return params.viewerId === params.ownerId
    ? { allowed: true }
    : { allowed: false, failure: TOOL_FAILURE.runForbidden };
}

/**
 * 调用工具函数，并把异常翻译成失败结果。
 *
 * 两档区分是必须的：`ToolInputError` 是用户能自己修的输入问题（400），其余异常是内部故障
 * （500，原错误挂 `cause` 交给调用方记日志）。把「用户填错」当 500 会让错误日志失真，
 * 也会让用户看到一句没有信息量的「服务器错误」。
 *
 * 与 `checkToolInput` 同理导出：`runFailed` 这一档要代入一个会抛错的人造工具才可测，
 * 内置的四个纯函数都不会抛未预期的异常。
 */
export function executeToolFunction(
  tool: ToolDefinition,
  input: Record<string, string>,
): { ok: true; output: ToolOutput } | { ok: false; failure: ToolFailure } {
  try {
    return { ok: true, output: tool.run(input) };
  } catch (error) {
    return {
      ok: false,
      failure:
        error instanceof ToolInputError
          ? { ...TOOL_FAILURE.inputInvalid, field: error.field }
          : { ...TOOL_FAILURE.runFailed, cause: error },
    };
  }
}

/** 执行一次工具。顺序与每条分支的副作用见文件头。 */
export async function runTool(
  ports: ToolRunPorts,
  request: { userId: string; slug: string; input: ToolInput },
): Promise<ToolRunOutcome> {
  const startedAt = ports.now();
  const elapsedMs = (): number => Math.max(0, ports.now().getTime() - startedAt.getTime());

  const tool = findTool(request.slug);
  if (!tool) {
    // 连工具都不存在，这次调用无法归属到任何工具，落历史没有意义。
    return { ok: false, failure: TOOL_FAILURE.toolNotFound };
  }

  const values = normalizeToolInput(tool, request.input);

  const violation = checkToolInput(tool, values);
  if (violation) {
    await recordFailure(ports, {
      tool,
      userId: request.userId,
      values,
      failure: violation,
      durationMs: elapsedMs(),
      createdAt: startedAt,
    });
    return { ok: false, failure: violation };
  }

  const quota = Math.max(0, Math.trunc(ports.quotaPerHour));
  const since = new Date(startedAt.getTime() - TOOL_QUOTA_WINDOW_MS);
  const recentRuns = await ports.countRunsSince({ userId: request.userId, since });
  if (recentRuns >= quota) {
    // 配额拒绝不落历史，理由见文件头第 3 条。
    return { ok: false, failure: TOOL_FAILURE.quotaExceeded };
  }

  const executed = executeToolFunction(tool, values);
  if (!executed.ok) {
    await recordFailure(ports, {
      tool,
      userId: request.userId,
      values,
      failure: executed.failure,
      durationMs: elapsedMs(),
      createdAt: startedAt,
    });
    return { ok: false, failure: executed.failure };
  }

  const output = executed.output;

  const durationMs = elapsedMs();
  const summary = buildRunSummary({ tool, input: values, output });
  const runId = ports.newRunId();
  await ports.recordRun({
    id: runId,
    userId: request.userId,
    toolSlug: tool.slug,
    status: 'succeeded',
    errorCode: null,
    durationMs,
    createdAt: startedAt,
    ...summary,
  });

  return { ok: true, runId, output, durationMs };
}

/** 失败历史的落盘。失败也要有记录，否则「用户说失败了但我查不到」无法回答。 */
async function recordFailure(
  ports: ToolRunPorts,
  params: {
    tool: ToolDefinition;
    userId: string;
    values: Record<string, string>;
    failure: ToolFailure;
    durationMs: number;
    createdAt: Date;
  },
): Promise<void> {
  const { tool, userId, values, failure, durationMs, createdAt } = params;
  const summary = buildRunSummary({ tool, input: values, output: null });

  await ports.recordRun({
    id: ports.newRunId(),
    userId,
    toolSlug: tool.slug,
    status: 'failed',
    errorCode: failure.code,
    durationMs,
    createdAt,
    ...summary,
  });
}
