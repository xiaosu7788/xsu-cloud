/**
 * 账号与登录方式规则。
 *
 * 对应 `docs/PRD.md` 3.6 与 `docs/INTEGRATIONS.md` 第 7 节定下的三条策略：
 *
 * 1. **不自动关联。** OAuth 首次登录一律新建账号，绝不按邮箱合并到已有账号。
 *    这条**不在这里判定**——它由「登录只按 `(provider_id, account_id)` 精确查表」
 *    这个事实保证（见 `docs/DATA-MODEL.md` 3.3）：系统里没有「按邮箱找本地用户」
 *    的代码路径，也就没有可被绕过的判定函数。加一个 `if (emailVerified)` 之类的
 *    谓词反而会给人「默认会合并、只是条件没满足」的印象。
 * 2. **绑定须主动发起。** 绑定是登录之后由用户发起的动作，因此没有「未登录也能绑定」
 *    的入口；这里只负责拒绝重复绑定。
 * 3. **绑定必须有反向操作，但不能把人锁死。** 用户能解除绑定，且只在**还有其他可用
 *    登录方式**时才允许解除。
 *
 * 「可用」不等于「已绑定」：提供方可能被配置摘掉（`INTEGRATIONS.md` 第 7 节要求
 * Linux.do 能够单独下线而不影响其他登录方式）。此时绑定关系还在，但那条路走不通，
 * 不能算作一条可用的登录方式。只数绑定条数，会在用户「绑着两个、其中一个是死的」
 * 时错误放行解除，最后把人锁在门外——这正是退出登录后回不来的经典事故。
 *
 * 邮箱密码是主路径（`INTEGRATIONS.md` 第 7 节：任何 OAuth 失败时都必须还能用邮箱密码
 * 登录），所以 `credential` 只要在册就视为可用，不受外部提供方开关影响。
 */

/**
 * Better Auth 把邮箱密码账号存成 `providerId = 'credential'`，且 `accountId` 等于用户 id。
 * 这个字面量是对方的事实，不是本项目的命名，改不动（已在 `better-auth@1.7.7` 的
 * `dist/api/routes/sign-in.mjs` 与 `dist/db/internal-adapter.mjs` 中核实）。
 */
export const CREDENTIAL_PROVIDER = 'credential';

/**
 * 该用户名下的一条账号记录。只保留判定用得上的字段——口令散列、token 之类的数据
 * 没有必要进入领域层。
 */
export type StoredAccount = {
  /** `credential` 或某个 OAuth 提供方的 id。 */
  providerId: string;
};

/** 一条登录方式，以及它当前是否走得通。 */
export type LoginMethod = {
  providerId: string;
  /** 提供方已被摘掉时为 false：绑定还在，但这条路走不通。 */
  usable: boolean;
};

export const ACCOUNT_REJECTION = {
  alreadyLinked: {
    code: 'ACCOUNT_ALREADY_LINKED',
    message: '该登录方式已绑定到当前账号，无需重复绑定。',
  },
  notLinked: {
    code: 'ACCOUNT_NOT_LINKED',
    message: '当前账号没有绑定这个登录方式。',
  },
  lastLoginMethod: {
    code: 'ACCOUNT_LAST_LOGIN_METHOD',
    message: '这是当前账号唯一可用的登录方式，解除后将无法登录。请先绑定其他登录方式。',
  },
} as const;

export type AccountRejection = (typeof ACCOUNT_REJECTION)[keyof typeof ACCOUNT_REJECTION];

export type AccountCheck = { ok: true } | { ok: false; rejection: AccountRejection };

const accountCheckOk: AccountCheck = { ok: true };

function reject(rejection: AccountRejection): AccountCheck {
  return { ok: false, rejection };
}

/**
 * 把账号记录映射成登录方式，并标出哪些当前可用。
 *
 * `enabledProviders` 是**当前实际注册了**的外部提供方 id（由服务端配置决定，不是
 * 全量提供方清单）。它故意由调用方传入而不是在这里读配置：领域层不碰配置。
 */
export function toLoginMethods(
  accounts: readonly StoredAccount[],
  enabledProviders: readonly string[],
): LoginMethod[] {
  return accounts.map((account) => ({
    providerId: account.providerId,
    usable:
      account.providerId === CREDENTIAL_PROVIDER || enabledProviders.includes(account.providerId),
  }));
}

export function isProviderLinked(methods: readonly LoginMethod[], providerId: string): boolean {
  return methods.some((method) => method.providerId === providerId);
}

/**
 * 解除 `providerId` 之后还剩几条可用登录方式。
 *
 * 注意 `usable` 而非「已绑定」：被摘掉的提供方不计入，这正是这个函数存在的理由。
 */
export function countRemainingUsableLoginMethods(
  methods: readonly LoginMethod[],
  providerId: string,
): number {
  return methods.filter((method) => method.usable && method.providerId !== providerId).length;
}

/** 绑定前的检查：只拒绝重复绑定，不对「能不能绑」设其他门槛。 */
export function checkAccountLinkable(
  methods: readonly LoginMethod[],
  providerId: string,
): AccountCheck {
  if (isProviderLinked(methods, providerId)) {
    return reject(ACCOUNT_REJECTION.alreadyLinked);
  }
  return accountCheckOk;
}

/**
 * 解除绑定前的检查。两个拒绝原因必须能分开：用户要知道是「本来就没绑」还是
 * 「解了会登不进去」，否则只能得到一句没法行动的提示。
 */
export function checkAccountUnlinkable(
  methods: readonly LoginMethod[],
  providerId: string,
): AccountCheck {
  if (!isProviderLinked(methods, providerId)) {
    return reject(ACCOUNT_REJECTION.notLinked);
  }
  if (countRemainingUsableLoginMethods(methods, providerId) === 0) {
    return reject(ACCOUNT_REJECTION.lastLoginMethod);
  }
  return accountCheckOk;
}
