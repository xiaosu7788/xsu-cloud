'use server';

/**
 * 注册的 Server Action，全站唯一的注册入口。
 *
 * 为什么必须是 Server Action 而不是库自带的 HTTP 端点：`packages/platform/src/auth.ts`
 * 用 `disabledPaths` 把 `/sign-up/email` 关掉了（那里写了为什么）。注册要过邀请码准入，
 * 而「先判定、再建号、建号成功才消费、消费失败就回滚」的顺序属于领域层
 * （`packages/core/src/registration.ts`），浏览器不该绕过它直接调库的端点。
 *
 * 这一层只做两件翻译：把 `FormData` 摊成一次注册尝试，把结果摊成表单状态。
 * 不写判定、不拼 SQL（`docs/ARCHITECTURE.md` 2.1 对应用层的要求）。
 *
 * 注册成功**不签发会话**：`requireEmailVerification` 已打开，库会在建号后自己发验证邮件，
 * 用户必须先点邮件里的链接。因此成功状态是「去查邮件」，不是跳转控制台。
 */
import { registerWithInvite, REGISTRATION_FAILURE } from '@xsu/core';
import { createRegistrationPorts } from '@xsu/platform';

import { readField, type SignUpState } from '@/features/auth/sign-up';

export async function signUpWithInvite(
  _previous: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const outcome = await registerWithInvite(createRegistrationPorts(), {
    name: readField(formData, 'name').trim(),
    email: readField(formData, 'email').trim(),
    password: readField(formData, 'password'),
    inviteCode: readField(formData, 'inviteCode'),
  });

  if (outcome.ok) return { status: 'created' };

  const { failure } = outcome;
  /*
   * 回滚失败是运维事故，必须能在日志里查到：库里会留下一个「注册成功但没消费邀请码」的
   * 账号，只能人工处理（`packages/core/src/registration.ts` 的 `rollbackFailed`）。
   * 其余失败都是用户能自己修的问题，交给表单回显，不进日志。
   */
  if (failure.code === REGISTRATION_FAILURE.rollbackFailed.code) {
    console.error('[sign-up] 注册回滚失败', failure.cause);
  }

  return { status: 'error', message: failure.message };
}
