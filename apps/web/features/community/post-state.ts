/**
 * 社区表单（发帖 / 编辑、评论）的服务端与客户端共享件。
 *
 * 单独成文件与 `features/tools/run-state.ts` 同一条理由：`'use server'` 文件只允许导出异步函数，
 * 状态类型必须另有出处，否则客户端组件拿不到它。
 *
 * 这里不放任何判定规则：标题能不能为空、正文超不超长、配额超没超，全部由 `@xsu/core` 的
 * `src/community/` 给出；本文件只定义「表单看到的结果」的形状。
 */

/**
 * 一次发帖 / 编辑提交的结果。
 *
 * ## 成功态为什么带 `postId`
 *
 * 新建与编辑的成功路径都是 `redirect()` 到帖子页（`redirect` 抛出的控制流会被 Next 接住，
 * 不会真的以 `ok` 态返回），所以 `ok` 分支在当前页面上**不会被渲染**——保留它是因为
 * `useActionState` 的状态类型必须覆盖 action 的全部返回形状，少写一个分支就是一处
 * 「类型说谎」。失败态带稳定错误码的理由与 `ToolRunState` 相同：错误码本身是规格的一部分。
 */
export type PostFormState =
  | { status: 'idle' }
  /** 提交成功（当前实现会紧接着 redirect，本分支只保证类型完整）。 */
  | { status: 'ok'; postId: string }
  /** 结构化失败。`field` 指出是哪个输入字段（领域层给的），表单据此高亮。 */
  | { status: 'error'; code: string; message: string; field?: string };

/** `useActionState` 的初始值。与 `INITIAL_TOOL_RUN_STATE` 同一理由，避免两处各写字面量。 */
export const INITIAL_POST_FORM_STATE: PostFormState = { status: 'idle' };

/**
 * 一次评论提交的结果。
 *
 * 成功没有数据负载：新评论由 action 里的 `revalidatePath` 让详情页重新渲染出来，表单在
 * React 19 的 `<form action>` 语义下自动重置，这里没有任何需要回填的值。
 */
export type CommentFormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; code: string; message: string; field?: string };

export const INITIAL_COMMENT_FORM_STATE: CommentFormState = { status: 'idle' };
