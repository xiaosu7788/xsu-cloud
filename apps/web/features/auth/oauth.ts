/**
 * OAuth 的展示文案与回调错误映射。
 *
 * ## 为什么提供方 id 不在这里新定义
 *
 * `id` 直接取 `@xsu/platform` 的 `OAuthProviderId`（**只 import type**，编译后不剩任何代码，
 * 因此这个文件可以安全地被客户端组件引用；`@xsu/platform` 本身会拉进数据库与鉴权实例，
 * 绝不能出现在浏览器包里）。
 *
 * 用 `satisfies` 而不是 `Record<OAuthProviderId, string>` 做类型标注：往 `OAuthProviderId`
 * 里加一个提供方而忘了加文案时，编译直接失败，而不是在页面上渲染出一个 `undefined`。
 *
 * ## 为什么回调错误要在这里翻译
 *
 * OAuth 失败**不会**以 JSON 形式回到前端：`better-auth@1.7.7` 的
 * `dist/oauth2/errors.mjs` 里每个失败点都走 `redirectOnError`，把机器可读的
 * `?error=<code>` 附在错误回调地址上再重定向。所以第三方登录失败的可见性只能靠
 * 「`errorCallbackURL` 指回登录页 + 登录页读这个参数」这一条链，不读它用户就只看到
 * 页面刷新了一下、什么也没发生。
 *
 * 键取自同文件的 `OAUTH_CALLBACK_ERROR_CODES`，不是猜的。没有列出的一律给通用文案：
 * 少一条映射的代价是文案不精确，而不给兜底会让错误静默。
 */

import type { OAuthProviderId } from '@xsu/platform';

/** 提供方 id 到按钮文案。 */
export const OAUTH_PROVIDER_LABEL = {
  github: 'GitHub',
  linuxdo: 'Linux.do',
} as const satisfies Record<OAuthProviderId, string>;

/** 登录页要渲染的一个第三方登录入口。 */
export type SignInProvider = {
  id: OAuthProviderId;
  label: string;
};

/** 回调错误码到用户可读文案。 */
const OAUTH_CALLBACK_MESSAGE: Record<string, string> = {
  no_code: '第三方登录未完成授权，请重新尝试。',
  oauth_provider_not_found: '该登录方式当前未启用。',
  invalid_code: '第三方登录的授权已失效，请重新尝试。',
  unable_to_get_user_info: '读取第三方账号信息失败，请稍后重试。',
  unable_to_link_account: '绑定第三方账号失败，请稍后重试。',
  email_does_not_match: '第三方账号的邮箱与本账号不一致，不能用于绑定。',
  account_already_linked_to_different_user: '该第三方账号已经绑定到另一个账号。',
  email_not_found: '该第三方账号没有返回可用邮箱，无法用于登录。',
  email_not_verified: '该第三方账号的邮箱未通过验证，无法用于登录。',
};

const OAUTH_CALLBACK_FALLBACK = '第三方登录失败，请稍后重试。';

/**
 * 把 URL 上的 `?error=` 翻译成中文。
 *
 * 收 `string | string[] | undefined` 是因为 Next 的 `searchParams` 在参数重复出现时给出数组。
 * 数组按「不可识别」处理：重复参数是异常输入，不该被当成某个具体错误来解释。
 */
export function readOAuthCallbackError(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return OAUTH_CALLBACK_MESSAGE[value] ?? OAUTH_CALLBACK_FALLBACK;
}
