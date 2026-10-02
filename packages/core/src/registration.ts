/**
 * 邀请码注册的编排（`docs/PRD.md` 3.6：本站不开放自由注册，注册必须携带邀请码）。
 *
 * 这里只写「按什么顺序做」，不写「怎么做」：建用户、抢码、删除用户都由
 * `RegistrationPorts` 的实现提供（应用层的 Better Auth 适配器 + `@xsu/db` 的仓储）。
 * 好处是这个顺序能被纯内存的假实现完整跑一遍，包括最要紧的两条失败路径。
 *
 * ## 顺序，以及它守住的三个性质
 *
 * 1. **先判定，后建号。** 明显不可用的码在建用户之前就挡掉，不必写一次再删一次。
 *    判定通过只代表「此刻看起来能用」，不代表抢到了码——并发下码会在两步之间失效。
 * 2. **建号成功才消费。** 所以「邮箱已注册」这类失败**不会消耗邀请码**：用户换个邮箱
 *    重试，同一个码还在。这条性质有测试锁定（`tests/registration.test.ts`），
 *    不要把两步调换顺序。
 * 3. **消费失败必须回滚。** 抢码失败的请求已经建出了账号，必须删掉，否则库里会留下
 *    一个「没消费任何邀请码却注册成功」的账号。
 *
 * 「为什么不能先消费再建号」写在 `@xsu/db` 的 `repositories/invites.ts` 文件头。
 *
 * ## 这里不做什么
 *
 * 口令强度、邮箱格式、邮箱是否已验证、限流与配额都不在这里：格式与强度的**执行**交给
 * Better Auth（`packages/platform/src/auth.ts` 把下限显式配成下面的 `PASSWORD_MIN_LENGTH`，
 * 邮箱格式由库自己校验），限流是 `docs/PRD.md` 4.4 的注册限流（M1 记为已知债务，见
 * `docs/ROADMAP.md`）。**口令在这里只被原样传递一次**，不加工、不记录、不进入任何错误文案。
 */
import {
  checkInviteUsable,
  INVITE_REJECTION,
  normalizeInviteCode,
  type InviteSnapshot,
} from './invites';

/**
 * 口令长度下限。
 *
 * 这个数字在仓库里有四个使用点：服务端配置（Better Auth 的 `minPasswordLength`）、
 * 服务端错误文案、前端输入提示、以及前端 `minLength`。分散写四处必然漂移，其中
 * 「提示说 8 位、服务端按 10 位拒」这种不一致只有用户会碰到，测试很难覆盖。
 *
 * 放在领域层而不是界面层：它是「注册准入」这条规则的一部分，不是某个界面的细节。
 *
 * 为什么不用库的默认值而显式配置：`better-auth@1.7.7` 把默认下限内联在
 * `dist/create-context.mjs` 第 186 行（`options.emailAndPassword?.minPasswordLength || 8`），
 * 没有导出成常量，前端也无从引用。显式配置之后这个数字由本仓库掌握，
 * 库的默认值变化不会在我们的提示文案与真实校验之间造成分叉。
 */
export const PASSWORD_MIN_LENGTH = 8;

/** 建号请求。口令是明文，散列是适配器的事。 */
export type CreateUserRequest = {
  name: string;
  email: string;
  password: string;
};

/**
 * 拒绝原因。`code` 给程序判断，`message` 可以直接给用户看。
 *
 * `cause` 只在拿得到底层错误时才带（目前只有回滚失败一处）。字段可选，
 * 因此从 `INVITE_REJECTION` 借来的原因也都满足这个类型。
 */
export type RegistrationFailure = {
  code: string;
  message: string;
  cause?: unknown;
};

/**
 * 建号结果。
 *
 * `emailTaken` 必须由适配器给出：只有它能拿到数据库的唯一约束错误并翻译成业务含义。
 * 领域层不去猜错误码字符串——那是对方（Better Auth）的实现细节，随版本变。
 */
export type CreateUserOutcome =
  { ok: true; userId: string } | { ok: false; emailTaken: boolean; failure: RegistrationFailure };

/** 原子消费结果。与 `@xsu/db` 的 `ConsumeInviteResult` 同形；判定仍留在领域层。 */
export type ConsumeInviteOutcome =
  { consumed: true; inviteId: string } | { consumed: false; snapshot: InviteSnapshot | null };

/**
 * 编排依赖的端口。全部由调用方注入，领域层不直接碰数据库与鉴权库。
 *
 * `now()` 是端口而不是在函数里取当前时间：判定与消费必须用同一个时间点，
 * 两边各取一次会在过期边界上互相矛盾；顺带也让边界可测。
 */
export type RegistrationPorts = {
  createUser(request: CreateUserRequest): Promise<CreateUserOutcome>;
  findInvite(code: string): Promise<InviteSnapshot | null>;
  consumeInvite(params: { code: string; userId: string; now: Date }): Promise<ConsumeInviteOutcome>;
  /**
   * 回滚：删掉刚建出来的账号。`user` 上的外键是 `ON DELETE CASCADE`，
   * 会话与账号绑定会一起清掉，「失败不留账号」因此成立。
   *
   * 用户已经不存在时**不算失败**：目标状态已经达成，抛错只会在重试路径上误报。
   */
  deleteUser(userId: string): Promise<void>;
  now(): Date;
};

export type RegistrationAttempt = {
  name: string;
  email: string;
  password: string;
  inviteCode: string;
};

/** 编排自己产的失败原因。适配器传来的失败原样透传，不在这里重新命名。 */
export const REGISTRATION_FAILURE = {
  /**
   * 一次都不该出现：判定说码可用，随即消费没抢到，重读又显示码仍可用。
   * 只可能来自「读到的状态落后于写入」这类不一致。给「重试一次」而不是「码无效」，
   * 因为此刻还没有任何证据说这个码有问题。
   */
  inviteConflict: {
    code: 'REGISTRATION_INVITE_CONFLICT',
    message: '邀请码状态刚刚发生变化，请重新提交一次。',
  },
  /** 回滚失败：库里已经有一个没消费邀请码的账号。必须让人知道去处理。 */
  rollbackFailed: {
    code: 'REGISTRATION_ROLLBACK_FAILED',
    message: '注册未完成，且新账号未能回滚。请联系管理员处理后再试。',
  },
} as const;

export type RegistrationOutcome =
  { ok: true; userId: string; inviteId: string } | { ok: false; failure: RegistrationFailure };

/**
 * 带邀请码注册。
 *
 * 返回 `ok: false` 时只有两种落库状态：什么都没建（判定或建号失败），
 * 或者账号已删干净（消费失败且回滚成功）。回滚失败会带 `rollbackFailed` 明说。
 */
export async function registerWithInvite(
  ports: RegistrationPorts,
  attempt: RegistrationAttempt,
): Promise<RegistrationOutcome> {
  // 用户从聊天窗口复制的码常带空格或换行；大小写不归一（见 `./invites`）。
  const code = normalizeInviteCode(attempt.inviteCode);
  if (code === '') {
    return { ok: false, failure: INVITE_REJECTION.required };
  }

  const now = ports.now();

  const precheck = checkInviteUsable(await ports.findInvite(code), now);
  if (!precheck.ok) {
    return { ok: false, failure: precheck.rejection };
  }

  const created = await ports.createUser({
    name: attempt.name,
    email: attempt.email,
    password: attempt.password,
  });
  if (!created.ok) {
    // 邀请码此刻还没被消费，用户换邮箱重试仍能用同一个码。
    return { ok: false, failure: created.failure };
  }

  const consumed = await ports.consumeInvite({ code, userId: created.userId, now });
  if (consumed.consumed) {
    return { ok: true, userId: created.userId, inviteId: consumed.inviteId };
  }

  // 没抢到码：账号已经建出来了，先算出该给用户看的提示，再回滚。
  const rejection = checkInviteUsable(consumed.snapshot, now);

  try {
    await ports.deleteUser(created.userId);
  } catch (error) {
    // 不吞异常：原错误挂在 `cause` 上交给调用方记日志（领域层不写日志）。
    return { ok: false, failure: { ...REGISTRATION_FAILURE.rollbackFailed, cause: error } };
  }

  return {
    ok: false,
    failure: rejection.ok ? REGISTRATION_FAILURE.inviteConflict : rejection.rejection,
  };
}
