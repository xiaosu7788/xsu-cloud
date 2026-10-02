/**
 * 服务端鉴权实例（Better Auth）。
 *
 * 本文件只做一件事：把配置、数据库与邮件端口拼成一个鉴权实例。
 * 「谁能做什么」「注册要不要邀请码」这类判定不在这里——它们在 `@xsu/core`
 * （`packages/core/src/registration.ts`、`access.ts`）和调用本实例的应用层。
 *
 * ## 建号只有一条路
 *
 * `disabledPaths: ['/sign-up/email']` 让 HTTP 上的注册端点直接返回 404。
 * 这是实测确认的：`disabledPaths` 只在 HTTP 路由层生效
 * （`better-auth@1.7.7` 的 `dist/api/index.mjs` 第 166-168 行，命中即 404），
 * 而服务端的 `auth.api.signUpEmail` 走的是另一条通路（`toAuthEndpoints`），不受影响。
 * 于是注册只剩一条路：应用层**带邀请码**调用 `auth.api.signUpEmail`。
 * 删掉这一条，任何人都能绕开邀请码建号（`docs/PRD.md` 3.6）。
 *
 * 第三方登录同样不允许建号（各提供方的 `disableSignUp`）：OAuth 是「已注册用户的
 * 登录方式与绑定方式」，新账号必须先凭邀请码注册。只写 `disableImplicitSignUp` 不够——
 * 客户端可以在 `/sign-in/social` 的请求体里传 `requestSignUp: true` 绕过去，
 * 只有 `disableSignUp` 是客户端说了不算的（`dist/api/routes/sign-in.mjs` 第 197 行、
 * `dist/api/routes/callback.mjs` 第 181 行，genericOAuth 同理由它自己的
 * `dist/plugins/generic-oauth/index.mjs` 第 260-263 行转发）。这条门关的是「建号」不是
 * 「绑定」：已登录用户的 `/link-social` 走 `linkOAuthAccount`，不受 `disableSignUp` 影响。
 *
 * ## 账号不自动关联
 *
 * `accountLinking.disableImplicitLinking: true`，对应 `docs/PRD.md` 决策 10。
 * 这一条不能省：Better Auth 在找不到绑定记录时会**按邮箱找本地用户**
 * （`dist/oauth2/link-account.mjs` 第 119-125 行），找到就当成同一个人的账号，
 * 只要邮箱已核实或提供方被信任就自动合并（同文件第 139 行）。关掉之后同一处直接返回
 * `account not linked`。绑定因此只能由已登录用户主动发起。
 *
 * 另外刻意**不配置** `accountLinking.trustedProviders`：显式绑定要求提供方报告邮箱已核实
 * （同文件第 43 行），GitHub 的 `emailVerified` 来自 `/user/emails`
 * （`@better-auth/core` 的 `src/social-providers/github.ts` 第 165-170 行），所以绑定
 * GitHub 可行；Linux.do 是否返回该字段尚未核实，因此在核实之前它会因这一条被拒。
 * 这是保守默认值，不是缺陷——放开它之前先确认该提供方的字段语义。
 *
 * ## 不开会话 cookie 缓存
 *
 * `session.cookieCache` 一律不开。`docs/PRD.md` 3.6 的验收 4 要求「角色变更后权限立即
 * 生效」：角色每次从数据库读，改完下一个请求就生效；一旦把会话缓存进 cookie，
 * 被降权的用户在缓存过期前仍是管理员。想开之前先解决这一条。
 *
 * ## 邮件
 *
 * 邮件走 `MailTransport` 端口，不在这里调 SMTP。M1 只有控制台传输（见 `./mail`），
 * 它在生产环境会抛错——「邮件没接上」必须被看见，不能静默成功。
 *
 * 本文件里凡是写「实测」「核实」的地方，都是对着磁盘上 `better-auth@1.7.7` 的源码与类型
 * 定义确认过的；改这些行为之前请自己再确认一遍。
 */
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins';

import { PASSWORD_MIN_LENGTH } from '@xsu/core';
import { DEFAULT_ROLE, getDb, schema, type Database } from '@xsu/db';

import { getServerEnv, type OAuthProviderId, type ServerEnv } from './env';
import { createConsoleMailTransport, type MailTransport } from './mail';

/**
 * 被关掉的鉴权端点，值是相对 basePath（默认 `/api/auth`）的路径。
 *
 * **保持禁用**，理由见文件头。
 */
const DISABLED_PATHS = ['/sign-up/email'] as const;

/**
 * Linux.do 在提供方清单里的 id。
 *
 * 由 `OAuthProviderId` 收口：改了这里而没改 `./env` 的类型或解析，会在这里编译失败，
 * 而不是等到运行时发现「按钮指向一个不存在的提供方」。
 */
const LINUXDO_PROVIDER_ID = 'linuxdo' satisfies OAuthProviderId;

/** 建实例需要的依赖。全部注入，测试可以替换数据库与邮件端口。 */
export type AuthDeps = {
  env: ServerEnv;
  transport: MailTransport;
  /** 默认取 `@xsu/db` 的共享连接；测试可传入独立的库。 */
  db?: Database;
};

/**
 * 配好凭证的社交提供方。
 *
 * 没配的提供方**整个键不出现**：登录按钮与 `enabledOAuthProviders` 都按「键在不在」判断
 * （见 `./env` 与 `packages/core/src/accounts.ts` 的 `toLoginMethods`）。
 *
 * 不写 `scope`：库默认请求 `read:user` + `user:email`（GitHub 的默认值），够用且不必维护
 * 一份会过期的副本。
 */
function buildSocialProviders(env: ServerEnv): BetterAuthOptions['socialProviders'] {
  const github = env.oauth.github;
  if (!github) return undefined;

  return {
    github: {
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      disableSignUp: true,
      disableImplicitSignUp: true,
    },
  };
}

/**
 * 插件：目前只有 Linux.do 的通用 OAuth 提供方。
 *
 * 端点与凭证都来自配置（`./env` 里写了为什么不把端点写进代码），并且**不写 `scopes`**：
 * scope 与端点是同一类未核实的外部事实（`docs/INTEGRATIONS.md` 第 7 节），
 * 用库的默认值比固化一个猜的值强。
 */
function buildPlugins(env: ServerEnv): BetterAuthPlugin[] {
  const linuxdo = env.oauth.linuxdo;
  if (!linuxdo) return [];

  return [
    genericOAuth({
      config: [
        {
          providerId: LINUXDO_PROVIDER_ID,
          name: 'Linux.do',
          clientId: linuxdo.clientId,
          clientSecret: linuxdo.clientSecret,
          authorizationUrl: linuxdo.authorizationUrl,
          tokenUrl: linuxdo.tokenUrl,
          userInfoUrl: linuxdo.userInfoUrl,
          disableSignUp: true,
          disableImplicitSignUp: true,
        },
      ],
    }),
  ];
}

/**
 * 建鉴权实例。
 *
 * 只由 `getAuth` 与测试调用：实例持有连接池与配置，重复创建会重复建连接。
 */
export function createAuth(deps: AuthDeps) {
  const { env, transport } = deps;
  const db = deps.db ?? getDb();

  return betterAuth({
    appName: 'xsu-cloud',
    baseURL: env.auth.baseUrl,
    secret: env.auth.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      /**
       * 邮箱是账号身份的唯一凭据（第三方登录不建号），所以未验证邮箱不给会话。
       *
       * 副作用要知道：开启后「邮箱已注册」的注册请求会返回 **HTTP 200 与一个合成用户**
       * 而不是报错（`dist/api/routes/sign-up.mjs` 第 155 行与第 192-205 行）。
       * 调用方**不能**把返回的用户当已落库：必须回查一次该 id 是否真的存在。
       */
      requireEmailVerification: true,
      /**
       * 显式写出下限，不用库内联的默认值（8）。
       *
       * `better-auth@1.7.7` 把它内联在 `dist/create-context.mjs` 第 186 行
       * （`options.emailAndPassword?.minPasswordLength || 8`），没有导出成常量，前端无从引用。
       * 而这个数字在仓库里有四个使用点：这里、错误文案、输入提示、前端 `minLength`。
       * 分散写四处必然漂移，其中「提示说 8 位、服务端按别的值拒」只有用户会碰到。
       * 常量住在 `@xsu/core`（它是注册准入规则的一部分，见 `packages/core/src/registration.ts`）。
       */
      minPasswordLength: PASSWORD_MIN_LENGTH,
      /**
       * 改密后清掉该用户的其他会话。库默认为 false，那样「旧口令可能已经泄露」的场景下
       * 改密等于没做：旧会话照样有效，用户却以为已把别人踢下线。
       */
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await transport.send({
          to: user.email,
          subject: '重置你的密码 —— xsu-cloud',
          text: '有人请求重置这个邮箱对应的账号密码。如果不是你本人操作，忽略这封邮件即可。',
          link: url,
        });
      },
    },
    emailVerification: {
      /**
       * 显式写出，而不是依赖 `requireEmailVerification` 带来的隐含联动
       * （`dist/api/routes/sign-up.mjs` 第 241 行的 `sendOnSignUp ?? requireEmailVerification`）。
       * 这样以后单独关掉「必须验证才能登录」时，验证邮件不会跟着一起消失。
       */
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await transport.send({
          to: user.email,
          subject: '验证你的邮箱 —— xsu-cloud',
          text: '完成邮箱验证后即可登录。',
          link: url,
        });
      },
    },
    account: {
      accountLinking: {
        // 绑定能力保留，只是不许自动绑定（见文件头）。
        enabled: true,
        disableImplicitLinking: true,
      },
    },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          // 有默认值，因此注册时不必提交；`DEFAULT_ROLE` 与数据库默认值同源（见 `@xsu/db`）。
          required: false,
          defaultValue: DEFAULT_ROLE,
          /**
           * `input: false`：客户端**不能**在注册或改资料时提交 role。
           * 少了这一条，注册请求体里带 `role: 'admin'` 就能自己提权。
           */
          input: false,
        },
      },
    },
    socialProviders: buildSocialProviders(env),
    plugins: buildPlugins(env),
    disabledPaths: [...DISABLED_PATHS],
  });
}

/** 鉴权实例的类型。应用层需要时从这里取，不要自己写 `ReturnType`。 */
export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

/**
 * 进程内共享的鉴权实例。
 *
 * 与 `getServerEnv` 同样的理由：实例持有连接池与配置，每个请求新建一次会直接体现在
 * 数据库连接数上。缓存放在模块作用域，Next.js 开发态的重复求值也只会命中缓存。
 */
export function getAuth(): Auth {
  if (!cached) {
    const env = getServerEnv();
    cached = createAuth({ env, transport: createConsoleMailTransport(env) });
  }
  return cached;
}
