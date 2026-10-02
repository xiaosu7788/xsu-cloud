/**
 * 服务端配置的唯一读取点。
 *
 * 三条规则：
 *
 * 1. **只有这里读 `process.env`。** 其它模块要配置就从这里拿。散落的
 *    `process.env.X` 没有校验，名字拼错只会得到 `undefined`，而 `undefined`
 *    落在密钥位置往往表现为「鉴权悄悄失效」而不是启动失败。
 * 2. **本文件不处理 `DATABASE_URL`。** 连接串的解释权在 `@xsu/db`
 *    （见 `packages/db/src/client.ts` 文件头）。这里只负责把仓库根目录的 `.env`
 *    载入进程环境，让那一处能读到它。两处各校验一次就是两个事实来源。
 * 3. **必填项缺失就抛错，不给默认值兜底。** 密钥带默认值等于没有密钥。
 *
 * 有两点是实测确认过的行为，不要按直觉改：
 *
 * - `process.loadEnvFile` **不覆盖已存在的环境变量**。所以生产用真实环境变量注入时，
 *   即便服务器上同时躺着一个 `.env` 也顶不掉它——这正是我们要的语义。
 * - 报错**不回显任何值**。配置错误的信息会进日志与终端，把密钥原文写进去等于泄漏。
 */
import { existsSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

import { z } from 'zod';

/** OAuth 提供方 id。与 Better Auth 的 `providerId` 一致，前端按钮也按它索引。 */
export type OAuthProviderId = 'github' | 'linuxdo';

/** 一组 OAuth 凭证。 */
export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type ServerEnv = {
  nodeEnv: 'development' | 'test' | 'production';
  /** 生产环境标志。少数行为分叉（如禁止控制台邮件）看它，不看 NODE_ENV 字符串比较。 */
  isProduction: boolean;
  auth: {
    /** Better Auth 的 baseURL，同时是 OAuth 回调地址的基址。 */
    baseUrl: string;
    secret: string;
  };
  /**
   * 配好凭证的 OAuth 提供方。**没配的提供方整个键不存在**，
   * 调用方据此决定登录按钮是否渲染、以及登录方式是否算「可用」。
   */
  oauth: {
    github?: OAuthCredentials;
    /**
     * Linux.do 必须连端点和凭证一起配。
     *
     * 为什么不写死在代码里：`docs/INTEGRATIONS.md` 第 7 节明确要求端点与 scope
     * 「M1 落地前用真实应用确认，不依赖二手信息」。在确认之前把某个 URL 固化进
     * 代码，等于把一条没核实的外部事实变成项目事实。放配置里则既不失真，也不用改代码。
     */
    linuxdo?: OAuthCredentials & {
      authorizationUrl: string;
      tokenUrl: string;
      userInfoUrl: string;
    };
  };
};

/**
 * 空字符串按「未配置」处理。
 *
 * `.env.example` 里留空的项在 `.env` 里是一个空串而不是缺键，`z.string().min(1)`
 * 会把「我故意没配」判成「配错了」。这里先把空串归一成 `undefined`。
 */
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * 必须是带 http/https 协议的地址。
   *
   * 光写 `z.url()` 不够：`new URL('localhost:3000')` 是合法的，`localhost:` 被当成协议名，
   * 于是少写 `http://` 的配置能一路通过校验，直到 OAuth 回调地址拼出来才发现。加 `protocol`
   * 之后 zod 会先要求 `://` 再校验协议（`zod@4.6.5` 的 `v4/core/schemas.js` 第 234-236 行），
   * 这类值当场被拒。
   *
   * 也不用 zod 的 `httpUrl()`：它同时套了域名正则（同包 `v4/classic/schemas.js` 第 401-407 行
   * 的 `hostname: regexes.domain`），会把本地开发的 `http://localhost:3000` 一起拒掉。
   */
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
  /** 会话与一次性令牌的签名密钥。长度下限取 32，短于此的密钥不值得当作密钥。 */
  BETTER_AUTH_SECRET: z.string().min(32),
  GITHUB_CLIENT_ID: optionalText,
  GITHUB_CLIENT_SECRET: optionalText,
  LINUXDO_CLIENT_ID: optionalText,
  LINUXDO_CLIENT_SECRET: optionalText,
  LINUXDO_AUTHORIZATION_URL: optionalText,
  LINUXDO_TOKEN_URL: optionalText,
  LINUXDO_USERINFO_URL: optionalText,
});

/** 必须成对出现的凭证。只填一半的配置会在第一次登录时才炸，所以在这里拦下。 */
const CREDENTIAL_PAIRS = [
  { label: 'GitHub', idKey: 'GITHUB_CLIENT_ID', secretKey: 'GITHUB_CLIENT_SECRET' },
  { label: 'Linux.do', idKey: 'LINUXDO_CLIENT_ID', secretKey: 'LINUXDO_CLIENT_SECRET' },
] as const;

/** 配了 Linux.do 凭证就必须一起给全的端点。 */
const LINUXDO_ENDPOINT_KEYS = [
  'LINUXDO_AUTHORIZATION_URL',
  'LINUXDO_TOKEN_URL',
  'LINUXDO_USERINFO_URL',
] as const;

/** 拼一条可读的配置错误。只写键名与原因，不写值。 */
function configError(problems: readonly string[]): Error {
  return new Error(
    `服务端配置有 ${problems.length} 处问题（对照仓库根目录的 .env.example）：\n` +
      problems.map((problem) => `  - ${problem}`).join('\n'),
  );
}

/**
 * 解析并校验配置。纯函数：入参就是要检查的键值集合，不读全局状态，因此可直接单测。
 *
 * 跨字段的一致性检查（凭证是否成对、端点是否齐全）在手写的代码里做，而不是塞进
 * schema 的 `superRefine`：这些检查要给出中文说明，写成声明式的链式 refine 反而不如
 * 一段朴素循环清楚。
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(未命名项)';
      // 只报键名与原因。issue.message 来自上面的 schema，不含字段值。
      return `${key}：${issue.message}`;
    });
    throw configError(problems);
  }

  const value = parsed.data;
  const problems: string[] = [];

  for (const pair of CREDENTIAL_PAIRS) {
    const hasId = value[pair.idKey] !== undefined;
    const hasSecret = value[pair.secretKey] !== undefined;
    if (hasId !== hasSecret) {
      problems.push(
        `${pair.label}：${pair.idKey} 与 ${pair.secretKey} 必须同时配置（留空即视为不启用）`,
      );
    }
  }

  const linuxdoEnabled = value.LINUXDO_CLIENT_ID !== undefined;
  if (linuxdoEnabled) {
    const missing = LINUXDO_ENDPOINT_KEYS.filter((key) => value[key] === undefined);
    if (missing.length > 0) {
      problems.push(
        `Linux.do：启用后必须一并配置 ${missing.join('、')}（端点未核实前不写进代码，见 docs/INTEGRATIONS.md 第 7 节）`,
      );
    }
  }

  if (problems.length > 0) {
    throw configError(problems);
  }

  const oauth: ServerEnv['oauth'] = {};
  if (value.GITHUB_CLIENT_ID && value.GITHUB_CLIENT_SECRET) {
    oauth.github = { clientId: value.GITHUB_CLIENT_ID, clientSecret: value.GITHUB_CLIENT_SECRET };
  }
  if (
    value.LINUXDO_CLIENT_ID &&
    value.LINUXDO_CLIENT_SECRET &&
    value.LINUXDO_AUTHORIZATION_URL &&
    value.LINUXDO_TOKEN_URL &&
    value.LINUXDO_USERINFO_URL
  ) {
    oauth.linuxdo = {
      clientId: value.LINUXDO_CLIENT_ID,
      clientSecret: value.LINUXDO_CLIENT_SECRET,
      authorizationUrl: value.LINUXDO_AUTHORIZATION_URL,
      tokenUrl: value.LINUXDO_TOKEN_URL,
      userInfoUrl: value.LINUXDO_USERINFO_URL,
    };
  }

  return {
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    auth: {
      baseUrl: value.BETTER_AUTH_URL,
      secret: value.BETTER_AUTH_SECRET,
    },
    oauth,
  };
}

/**
 * 实际注册进来的 OAuth 提供方 id。
 *
 * 交给领域层的 `toLoginMethods` 判断某条登录方式当前是否走得通：被摘掉的提供方
 * 绑定还在，但不算一条可用登录方式（见 `packages/core/src/accounts.ts`）。
 */
export function enabledOAuthProviders(env: ServerEnv): OAuthProviderId[] {
  const providers: OAuthProviderId[] = [];
  if (env.oauth.github) providers.push('github');
  if (env.oauth.linuxdo) providers.push('linuxdo');
  return providers;
}

/** 仓库根目录的标记文件，也是 `.env` 的定位依据。 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * 仓库根目录 `.env` 的绝对路径。
 *
 * **不要用 `new URL('../../../.env', import.meta.url)`。** 打包器把这个写法识别成
 * 静态资源引用并改写它：Next.js 16 的 Turbopack 实测把本模块里的 `import.meta.url`
 * 在页面渲染图里改写成 `/_next/static/media/.env.<hash>`（`existsSync` 为假，配置读不到），
 * 在 API 路由图里改写成构建产物中另一份被复制的位置（读得到）。同一份配置在不同入口
 * 上有两种结果，表现是「登录接口正常、页面渲染 500」这种极难定位的割裂。
 *
 * 改用 `process.cwd()` 向上查找仓库根标记：Next 开发服务的 `cwd` 是 `apps/web`，
 * 仓库根脚本的 `cwd` 是仓库根，两者都会定位到同一个 `.env`。找不到标记时（例如产物
 * 被搬到别处执行）回退到 `cwd/.env`，让「文件不存在」如常走下面的报错路径。
 *
 * 这一处刻意加 `turbopackIgnore`：向上查找是运行期的动态文件系统访问，Turbopack 据此判定
 * 「整个项目都要被 trace 进服务端产物」，`next build` 会因此打出一条警告（M1 运行时验证
 * 实跑见到 1 条，指向本函数第 229 行的 `resolve`）。本项目部署走 Docker Compose 整仓
 * 拷贝，不依赖 `output: 'standalone'` 的文件追踪，所以这里只需要它别管这件事；
 * 忽略不影响运行期行为——`resolve` 只是算一个路径字符串。
 */
function resolveDotEnvPath(): string {
  const start = process.cwd();
  const { root } = parse(start);
  let current = resolve(/* turbopackIgnore: true */ start);

  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) {
      return join(current, '.env');
    }
    if (current === root) {
      return join(start, '.env');
    }
    current = resolve(current, '..');
  }
}

const DOT_ENV_PATH = resolveDotEnvPath();

let dotEnvLoaded = false;

/**
 * 把仓库根目录的 `.env` 载入进程环境。
 *
 * **缺文件不算错误**：生产环境用真实环境变量注入，没有 `.env` 是正常状态。
 * 缺的是必填项时，`parseServerEnv` 会给出比「文件不存在」更有用的报错。
 */
export function ensureDotEnvLoaded(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  if (existsSync(DOT_ENV_PATH)) {
    process.loadEnvFile(DOT_ENV_PATH);
  }
}

/** 读取并校验配置。只在进程内解析一次——解析结果不会在运行中变化。 */
export function getServerEnv(): ServerEnv {
  ensureDotEnvLoaded();
  cachedEnv ??= parseServerEnv(process.env);
  return cachedEnv;
}

let cachedEnv: ServerEnv | undefined;
