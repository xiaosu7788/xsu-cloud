/**
 * 注册编排的适配器：把 `@xsu/core` 的 `RegistrationPorts` 接到数据库与 Better Auth 上。
 *
 * 这一层只做「翻译」，不决定顺序——「先判定、再建号、建号成功才消费、消费失败就回滚」
 * 写在 `packages/core/src/registration.ts`，那里能用纯内存假实现把失败路径完整跑一遍。
 * 本文件负责的是领域层拿不到的那些事实：
 *
 * ## 1. 「邮箱已注册」只能在这里被识别
 *
 * 开了 `requireEmailVerification` 之后，用已注册邮箱调 `auth.api.signUpEmail` 得到的是
 * **HTTP 200 与一个合成用户**，而不是错误（`better-auth@1.7.7` 的
 * `dist/api/routes/sign-up.mjs` 第 155、159-191、195-202 行）。合成用户的 id 是新生成的
 * 随机值，不会命中数据库。所以判定方式是**回查**一次该 id 是否真的落库
 * （`@xsu/db` 的 `userExists`）——不要改成「解析错误码」，那条路径在我们的配置下不会走到。
 *
 * ## 2. 只有用户能自己修的错误才变成失败结果
 *
 * 邮箱格式、口令太短这类是用户输入问题，翻译成中文失败原因交给调用方回显；其余（例如
 * `FAILED_TO_CREATE_USER`、库没开邮箱注册）属于服务端配置或故障，**原样抛出**。
 * 把它们也包装成「注册失败，请稍后再试」会让配置错误伪装成用户错误，线上只能靠猜。
 *
 * ## 3. 回滚不放在事务里
 *
 * `deleteUser` 走独立语句，不包在「建号 + 消费」的事务里。理由是建号发生在 Better Auth
 * 内部（它自己开了事务边界），我们要包住它只能依赖对方的内部实现。代价（极端崩溃下可能
 * 留下一个没消费邀请码的账号）记录在 `docs/DATA-MODEL.md` 的已知债务里，并由
 * `REGISTRATION_FAILURE.rollbackFailed` 在日志里显式暴露。
 */
import { PASSWORD_MIN_LENGTH, type RegistrationPorts } from '@xsu/core';
import {
  consumeInvite,
  deleteUserById,
  findInviteByCode,
  getDb,
  userExists,
  type Database,
} from '@xsu/db';

import { getAuth, type Auth } from './auth';

/**
 * 「邮箱已被占用」的失败原因。
 *
 * 定义在这里而不是 `@xsu/core`：它不是业务规则，而是本适配器对 Better Auth 那个
 * 「合成用户」行为的翻译结果（见文件头第 1 条）。领域层不需要知道这个行为存在。
 */
const EMAIL_TAKEN = {
  code: 'REGISTRATION_EMAIL_TAKEN',
  message: '该邮箱已注册。若忘记口令请走「找回密码」，不要重复注册。',
} as const;

/** 用户输入类错误的翻译表。键是 Better Auth 的错误码，值是可直接展示的中文。 */
const INPUT_ERROR_MESSAGES: Record<string, string> = {
  INVALID_EMAIL: '邮箱格式不正确，请检查后重试。',
  INVALID_PASSWORD: '口令不能为空。',
  PASSWORD_TOO_SHORT: `口令不能短于 ${PASSWORD_MIN_LENGTH} 位。`,
  PASSWORD_TOO_LONG: '口令过长，请换一个短一些的口令。',
};

/**
 * 从 Better Auth 抛出的错误里读出错误码。
 *
 * 用结构化判断而不是 `instanceof APIError`：`@better-auth/core` 不是本包的依赖，
 * 为一次类型判断新增依赖不划算。这里只要求「错误对象上挂着 `body.code` 字符串」，
 * 这正是 APIError 的形状（`dist/api/routes/sign-up.mjs` 里一律用
 * `APIError.from(status, BASE_ERROR_CODES.X)` 构造，`code` 就来自 `BASE_ERROR_CODES`）。
 */
function readApiErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { body } = error as { body?: unknown };
  if (typeof body !== 'object' || body === null) return undefined;
  const { code } = body as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

export type RegistrationPortsDeps = {
  /** 默认取 `@xsu/db` 的共享连接。 */
  db?: Database;
  /** 默认取本包的共享鉴权实例。 */
  auth?: Auth;
};

/**
 * 建一个注册编排用的端口集合。每次请求都新建即可——它自己不持有连接。
 *
 * 两个依赖都可省：默认走 `getDb()` 与 `getAuth()`。理由不是省事，是分层：
 * `docs/ARCHITECTURE.md` 2.1 把 `packages/platform` 列为「可被应用层使用」，
 * 而数据层不在其列。默认值放在这里，应用层就不必自己 import `@xsu/db` 取连接，
 * 「怎么装配依赖」也只有这一处。
 */
export function createRegistrationPorts(deps: RegistrationPortsDeps = {}): RegistrationPorts {
  const db = deps.db ?? getDb();
  const auth = deps.auth ?? getAuth();
  return {
    async createUser({ name, email, password }) {
      let userId: string | undefined;

      try {
        /*
         * 口令在这里原样传递一次，不落日志、不进错误文案（见 `@xsu/core` 的 registration.ts）。
         * `emailVerification.sendOnSignUp` 已打开，库会在建号后自己发验证邮件；
         * 因此注册成功**不会**签发会话，用户必须先点邮件里的链接。
         */
        const result = await auth.api.signUpEmail({ body: { name, email, password } });
        userId = result.user?.id;
      } catch (error) {
        const code = readApiErrorCode(error);
        const message = code ? INPUT_ERROR_MESSAGES[code] : undefined;

        // 已知的用户输入问题：翻译成失败结果，让用户改完重试。
        if (code && message) {
          return { ok: false, emailTaken: false, failure: { code, message } };
        }

        // 其余（含 USER_ALREADY_EXISTS*，理论上到不了，见文件头第 1 条）原样抛出。
        throw error;
      }

      /*
       * 走到这里只有两种可能：真的建出了用户，或者库返回了合成用户。
       * 合成用户的 id 不会命中数据库，因此这一次回查同时区分了两者，
       * 也顺手确认了「账号确实落库」——后面要拿它的 id 去消费邀请码。
       */
      if (!userId || !(await userExists(db, userId))) {
        return { ok: false, emailTaken: true, failure: EMAIL_TAKEN };
      }

      return { ok: true, userId };
    },

    findInvite(code) {
      return findInviteByCode(db, code);
    },

    consumeInvite(params) {
      return consumeInvite(db, params);
    },

    deleteUser(userId) {
      return deleteUserById(db, userId);
    },

    /*
     * 时间由端口提供，判定与消费因此共用同一个时间点（见 `@xsu/core` 的 RegistrationPorts）。
     * 这里就是唯一一次取当前时间，两处各取会在过期边界上互相矛盾。
     */
    now() {
      return new Date();
    },
  };
}
