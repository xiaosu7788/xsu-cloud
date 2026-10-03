'use server';

/**
 * 工具箱的 Server Action：执行工具与收藏开关。
 *
 * ## 这一层只做翻译
 *
 * 「slug 在不在注册表里」「输入合不合法」「这次算不算超配额」「摘要怎么脱敏」全部在
 * `@xsu/core` 的 `src/tools/`；这里只把 `FormData` 摊成一次调用、把结果摊成表单状态
 * （`docs/ARCHITECTURE.md` 2.1 对应用层的要求：薄壳，无业务规则）。
 *
 * 数据访问一律经 `@xsu/platform` 的 `createToolPorts`，不 import `@xsu/db`——分层的唯一入口
 * 在那里，而 `userId` 在建端口时就绑定了，调用方拿不到「忘记按用户收窄」的机会。
 *
 * ## 未登录走重定向，不返回错误状态
 *
 * 「未登录怎么办」这件事在整个项目里只有一处实现：`features/auth/guard.ts`。执行页与工具台
 * 都只在登录后可见，所以这里的拒绝实际上是「会话在填表期间失效了」——把它做成重定向，与分区
 * 布局的行为一致，而不是在一个已经过期的页面上弹一句「请先登录」。判定之后仍然保留一条返回
 * 失败状态的分支：控制台今天对任何合法角色开放，但哪天判定收紧，这里不会漏掉一个没有响应的
 * 拒绝（与 `(console)/layout.tsx` 同一条结构）。
 *
 * ## 不 import `./format` 之外的展示件
 *
 * 状态类型从 `features/tools/run-state.ts` 取，字段名约定从 `features/tools/form-fields.ts`
 * 取，两者都是纯共享件，不含判定。
 */
import { findTool, isRegisteredToolSlug, runTool, TOOL_FAILURE } from '@xsu/core';
import { createToolPorts } from '@xsu/platform';
import { revalidatePath } from 'next/cache';

import { redirectToSignInIfUnauthenticated } from '@/features/auth/guard';
import { readConsoleAccess } from '@/features/auth/session';
import {
  readFavoriteIntent,
  readFormValue,
  readToolFieldValue,
  TOOL_SLUG_FIELD,
} from '@/features/tools/form-fields';
import { CONSOLE_TOOLS, CONSOLE_TOOLS_RUNS } from '@/features/tools/routes';
import type { ToolRunState } from '@/features/tools/run-state';

/**
 * 执行一次工具。
 *
 * 失败一律返回结构化状态（`code` + `message`），不抛异常给表单层：四种内置工具都是纯函数，
 * 唯一的「内部故障」是 `runFailed`，它由领域层翻译好并挂上 `cause`，这一层只负责记日志。
 */
export async function runToolAction(
  _previous: ToolRunState,
  formData: FormData,
): Promise<ToolRunState> {
  const access = await readConsoleAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    // 见文件头：当前不可达，留着是为了「拒绝必须有响应」这条结构。
    return { status: 'error', code: access.denial.code, message: access.denial.message };
  }

  const userId = access.user.id;
  const slug = readFormValue(formData, TOOL_SLUG_FIELD);
  const tool = findTool(slug);
  if (!tool) {
    /*
     * 先查目录再拼输入：工具不在注册表里时连字段有哪些都不知道，遍历 `tool.fields` 无从谈起。
     * 领域层的 `runTool` 也会查一次并给出同一个失败码——这里查只是为了拿到字段清单，
     * 判定权仍然在它那里（两处查表，一次判定）。
     */
    return {
      status: 'error',
      code: TOOL_FAILURE.toolNotFound.code,
      message: TOOL_FAILURE.toolNotFound.message,
    };
  }

  const input: Record<string, string> = {};
  for (const field of tool.fields) {
    input[field.name] = readToolFieldValue(formData, field.name);
  }

  const outcome = await runTool(createToolPorts({ userId }), { userId, slug, input });

  /*
   * 运行历史刚刚多了一行，`/console/tools/runs` 已经过期。这几页在 Next 16 下是动态渲染
   * （分区布局读会话），客户端路由缓存对动态段的默认失效时间是 0，所以这两行今天多半是空转；
   * 留着是因为它们表达的是「这两个视图不再新鲜」，哪天缓存策略的默认值变了，不至于静默出错。
   */
  revalidatePath(CONSOLE_TOOLS_RUNS);

  if (outcome.ok) {
    return {
      status: 'ok',
      runId: outcome.runId,
      output: outcome.output,
      durationMs: outcome.durationMs,
    };
  }

  const { failure } = outcome;
  /* 用户填错不该污染错误日志，只有未预期的内部故障才记。 */
  if (failure.code === TOOL_FAILURE.runFailed.code) {
    console.error('[tools] 工具执行失败', failure.cause);
  }

  return {
    status: 'error',
    code: failure.code,
    message: failure.message,
    ...(failure.field === undefined ? {} : { field: failure.field }),
  };
}

/**
 * 收藏开关。意图由隐藏字段 `__intent` 携带，来自服务端渲染这份表单时的实际状态。
 *
 * 返回 `void` 而不是结果对象：它由 `<form action={...}>` 直接驱动（纯服务端表单，没有
 * JavaScript 也能用），而表单 action 的返回值没有地方展示。因此异常一律外抛，不做
 * 「悄悄什么都不发生」——缺少了 `redirect` 那个分支就属于异常而不是拒绝。
 */
export async function toggleFavoriteAction(formData: FormData): Promise<void> {
  const access = await readConsoleAccess();
  if (!access.allowed) {
    redirectToSignInIfUnauthenticated(access.denial);
    return;
  }

  const intent = readFavoriteIntent(formData);
  const slug = readFormValue(formData, TOOL_SLUG_FIELD);
  /*
   * 两种情况在这里直接结束，且都不是错误：
   * - 意图不在 `FAVORITE_INTENTS` 里：表单被改坏了（`readFavoriteIntent` 不兜底成 `'add'`，
   *   否则一个被改坏的表单会静默地执行收藏，而用户以为自己在取消）；
   * - slug 不在注册表里：页面是渲染于某个工具下架之前的旧副本。
   * 两者的正确结果都是「不产生任何改动」，而唯一该拦下它们的判定已经在领域层写过一遍。
   */
  if (!intent || !isRegisteredToolSlug(slug)) return;

  const ports = createToolPorts({ userId: access.user.id });
  if (intent === 'add') {
    await ports.addFavorite(slug);
  } else {
    await ports.removeFavorite(slug);
  }

  // 与 `runToolAction` 同一条理由：工具台上的收藏状态已经过期。
  revalidatePath(CONSOLE_TOOLS);
}
