/**
 * 分区守卫的公共部分。
 *
 * ## 统一拒绝策略
 *
 * `docs/PRD.md` 3.5 验收 2 要求「非管理员访问后台路由得到**一致的**拒绝响应，不能一处
 * 403 一处 404 一处 500」；`docs/ROADMAP.md` M1 退出标准 3 是同一件事。因此拒绝只有两种，
 * 都由 `@xsu/core` 的 `ACCESS_DENIED` 表定义，分区布局只决定「翻译成人话是什么样子」：
 *
 * | 判定 | 含义 | 表现 |
 * | --- | --- | --- |
 * | `UNAUTHENTICATED` | 没登录，或会话已失效 | 重定向到登录页 |
 * | `FORBIDDEN` | 登录了但角色不够 | 渲染 `AccessDenied`，HTTP 仍是 200 |
 *
 * 为什么 403 不返回真正的 403 状态码：Next 的 `forbidden()` 能给出真 403，但它目前挂在
 * `experimental.authInterrupts` 下（见 `apps/web/next.config.ts` 的说明），本项目不为一个
 * 拒绝页引入实验特性。代价是状态码为 200，判断「是否被拒」要看响应体而不是状态码——
 * 这条记在 `docs/ROADMAP.md` 的已知债务里。
 *
 * ## 为什么是一个函数而不是两段 if
 *
 * 两个分区布局都要写这段判断。写成两段 if 之后，「401 去登录页」这条策略就有了两个副本，
 * 改动时漏掉一个的表现是「后台能登录、控制台白屏」这类只在某个分区暴露的问题。
 */
import { redirect } from 'next/navigation';
import { ACCESS_DENIED, type AccessDenial } from '@xsu/core';

import { SIGN_IN_PATH } from './routes';

/**
 * 未登录时把请求弹到登录页；不是未登录就什么都不做。
 *
 * 复用 `ACCESS_DENIED` 里的 `code` 而不是自己写 `'UNAUTHENTICATED'`：领域层换文案时
 * 这里不需要跟着改，判定条件也不会与拒绝表漂移。
 *
 * 返回值是 `void` 而不是 `never`：`redirect()` 靠抛异常中断渲染，但它不在类型上收窄调用点，
 * 所以调用方必须自己处理剩下的分支（也就是 `AccessDenied` 那一条）。这一点写在这里，
 * 免得后来者以为是漏了 `return`。
 */
export function redirectToSignInIfUnauthenticated(denial: AccessDenial): void {
  if (denial.code !== ACCESS_DENIED.unauthenticated.code) return;
  redirect(SIGN_IN_PATH);
}
