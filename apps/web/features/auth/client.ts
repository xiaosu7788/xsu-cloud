'use client';

/**
 * 浏览器端鉴权客户端。
 *
 * 不传 `baseURL`：`better-auth@1.7.7` 的客户端在浏览器里按当前源解析，服务端渲染时
 * 退化成相对路径 `/api/auth`（`dist/client/config.mjs` 第 25 行的兜底链）。于是本地、
 * 预览、生产共用一份代码，不必为它维护一个必须与部署环境对齐的公开变量。
 *
 * 只用它做三件事：读会话、登录、退出。
 *
 * **注册不在这里。** 注册要过邀请码准入，唯一入口是
 * `app/(site)/sign-up/actions.ts` 的 Server Action；库自身的 `/sign-up/email` 端点已被
 * `packages/platform/src/auth.ts` 的 `disabledPaths` 关掉（那里写了为什么）。
 * 在这里加 `signUp` 只会给出一条必然 404 的调用路径。
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
