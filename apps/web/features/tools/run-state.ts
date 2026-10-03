/**
 * 工具执行表单的服务端与客户端共享件。
 *
 * 单独成文件与 `features/auth/sign-up.ts` 同一条理由：`'use server'` 文件只允许导出异步函数
 * （Next 会检查），状态类型必须另有出处，否则客户端组件拿不到它。
 *
 * 这里不放任何判定规则：一个输入合不合法、这次执行算不算超配额，全部由 `@xsu/core` 的
 * `src/tools/` 给出。
 */
import type { ToolOutput } from '@xsu/core';

/**
 * 一次执行的结果。
 *
 * ## 为什么带 `code` 而注册表单不带
 *
 * 注册表单只显示 `message`（`SignUpState` 写了理由）。这里多带一个稳定错误码，是因为工具箱的
 * 错误码本身是规格的一部分：`docs/PRD.md` 3.3 验收 3 要求「超限返回**明确错误码**」，
 * 而执行页把码显示出来，才让「用户反馈说被拒了」这句话可以核对到具体是哪一条失败。
 * 文案仍然来自 `TOOL_FAILURE`，这里不做第二份翻译。
 *
 * ## 没有 HTTP 状态码
 *
 * `TOOL_FAILURE[*].status` 是给应用层组装 HTTP 响应的。Server Action 走的是 Next 自己的
 * 传输层，没有「这一次调用返回 429」这种东西，所以这里**不带 status**，也不假装带了。
 * 状态码存在的意义是给外部调用方（M4 的中转站接口）用，不在本页。
 */
export type ToolRunState =
  | { status: 'idle' }
  /** 执行成功。`runId` 让结果能直接链到运行历史的那一条。 */
  | { status: 'ok'; runId: string; output: ToolOutput; durationMs: number }
  /** 结构化失败。`field` 指出是哪个输入字段（领域层给的），表单据此高亮。 */
  | { status: 'error'; code: string; message: string; field?: string };

/** `useActionState` 的初始值。与 `INITIAL_SIGN_UP_STATE` 同一理由，避免两处各写字面量。 */
export const INITIAL_TOOL_RUN_STATE: ToolRunState = { status: 'idle' };
