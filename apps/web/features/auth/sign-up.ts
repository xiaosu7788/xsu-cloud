/**
 * 注册表单的服务端与客户端共享件。
 *
 * 为什么单独一个文件，而不是把状态类型写进 `app/(site)/sign-up/actions.ts`：
 * `'use server'` 文件只允许导出异步函数（Next 会检查这一条），状态类型必须另有出处。
 * 与 `./oauth.ts` 的做法一致——那里也是服务端页面与客户端组件共享的类型。
 *
 * 这里不放任何判定规则：注册能不能成、失败该说什么，全部由 `@xsu/core` 与
 * `@xsu/platform` 给出。
 */

/**
 * 注册表单状态。
 *
 * 只带 `message` 不带错误码：文案已经在服务端按错误码翻译成中文（见
 * `packages/platform/src/registration.ts` 的翻译表），客户端再按码分支就等于把同一套
 * 规则维护两遍。真正需要客户端知道码的场合（例如高亮某个输入框）等有第二个消费方时再说。
 */
export type SignUpState =
  | { status: 'idle' }
  /** 账号已建出来，等邮箱验证。注册不签发会话，所以这里不能直接进控制台。 */
  | { status: 'created' }
  | { status: 'error'; message: string };

/** `useActionState` 的初始值。放在这里是为了让 action 与表单引用同一个对象而不各自写字面量。 */
export const INITIAL_SIGN_UP_STATE: SignUpState = { status: 'idle' };

/**
 * 读一个表单字段。
 *
 * `FormData.get` 在字段缺失时返回 `null`，在同一个键出现多次时返回 `File`。
 * 两种都不是字符串，一律按空串处理——`null` 被当成字符串塞进领域层，
 * 会得到「邮箱格式不正确」这种把「没填」说成「填错」的误导文案。
 */
export function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
