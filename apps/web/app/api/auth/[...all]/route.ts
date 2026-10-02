/**
 * Better Auth 的 HTTP 端点（应用层薄壳）。
 *
 * `docs/ARCHITECTURE.md` 2.1：应用层只接线，不写业务规则。这里确实只有接线——
 * 端点集合、注册准入、账号绑定策略全在 `packages/platform/src/auth.ts` 与 `packages/core/src/*`。
 * 需要往这个文件里加逻辑时，先确认规则是不是放错了层。
 *
 * ## 传函数而不是实例
 *
 * `toNextJsHandler` 的入参可以是鉴权实例，也可以是 `(request) => Response`。用后者把
 * `getAuth()` 推迟到第一个请求：实例化要读齐服务端环境变量，放在模块作用域会让
 * `next build` 在收集路由信息时就开始要求这些变量。
 *
 * ## 只导出 GET 与 POST
 *
 * Better Auth 的端点全部走这两个方法。导出用不到的方法等于多给出一组「能匹配上路由、
 * 随后在库内报错」的入口。
 */
import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@xsu/platform';

const handlers = toNextJsHandler((request) => getAuth().handler(request));

export const GET = handlers.GET;
export const POST = handlers.POST;
