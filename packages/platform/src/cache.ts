/**
 * 缓存（Redis）。M3 首次落地，当前只有一个使用者：社区的点赞计数。
 *
 * `packages/platform/package.json` 的 description 早就写着 auth / cache / queue 三件事，
 * queue 在 M2 落地，cache 到 M3 才有第一个真正的需求——不是为了「用上 Redis」：点赞数是列表页
 * 每渲染一次都要取的一批数字，`docs/ARCHITECTURE.md` 第 4 节把「高频计数」列为 Redis 的用途，
 * `docs/PRD.md` 的公开页红线 2 说得更直接：轮询、点赞、阅读数走独立轻量接口，必要时以 Redis 承载。
 *
 * ## 一、数据库是事实来源，缓存只是加速
 *
 * `reactions` 表里的行才是「谁赞过」，缓存里的数字是**派生值**，最迟 60 秒后必然重建。这个定位
 * 决定了下面反复出现的三件事：
 *
 * - **缓存故障不影响结果**：读写失败一律吞掉并记一行日志，不往上抛。点赞的行已经落库了，这时
 *   因为 Redis 抖了一下就返回失败，用户会以为没点上而反复点（`@xsu/core` 的 `ReactionCountPort`
 *   头一句就是这个）。吞掉的是异常，不是日志——`apps/web/worker/index.ts` 文件头那句「吞异常与
 *   吞日志是两件事」在这里同样成立，所以每条失败路径都有一行 `[cache]` 记录。
 * - **只负责快，不负责正确**：命中就省一次数据库查询，没命中就回数据库算一遍并回填。
 * - **过期是唯一的收敛手段**，因此 TTL 不能长：60 秒是「用户看不出错」与「Redis 里不堆键」之间的
 *   折中，也是 `docs/spec/SPEC-community.md` 第 5 节写下的数字。
 *
 * ## 二、为什么加减计数要跑一段 Lua
 *
 * 直觉写法是 `INCR` / `DECR`，但它有个前提：键已经存在。缓存里没有这个键时（刚过期、刚部署、
 * Redis 重启过）`INCR` 会把一个真实值 5 变成 1，此后 60 秒里都显示 1。而「键不存在」与
 * 「值是 0」在 Redis 里都是 `nil` / `0`，光看 `INCR` 的返回值分不出来。
 *
 * 所以走脚本先问 `EXISTS`：**键在才改，不在就什么都不做**，等下一次读取回数据库重建——那时重建
 * 出来的值已经包含这次点赞（`addReaction` 先落库、缓存在后，顺序写在 `@xsu/core` 的
 * `community/reactions.ts`）。脚本在 Redis 里是原子的，「判断 + 修改」之间插不进别的命令。
 *
 * 减到负数时夹回 0 并保留存活时间：正常路径走不到，但计数是给人看的，宁可少一也不能是负的。
 *
 * ## 三、连接自己建、自己关，而且按地址共享
 *
 * 与队列同一条理由（`./queue.ts` 文件头第一、四条）：本项目的原生 ESM 图里只能自己建客户端传进去，
 * 而「谁建谁关」意味着退出时得有人拿着这个实例。这里也一样——**每次请求新建一个 ioredis 实例会
 * 让列表页每渲染一次就多一条连接**，所以进程内按 Redis 地址共享一个（`getReactionCountCache`），
 * 需要独立实例的测试用 `createReactionCountCache`。
 *
 * `enableOfflineQueue: false` 是**快速失败**：缓存跑在用户请求路径上，把命令挂在离线队列里等重连，
 * 等于让一次点赞跟着 Redis 一起卡住——而它本来最多只是「数字晚 60 秒才对」。这一条与队列的生产者
 * 连接同一个取舍，理由见 `./queue.ts` 文件头第二条。
 */
import type { ReactionCountPort } from '@xsu/core';
import Redis from 'ioredis';

import type { ServerEnv } from './env';

/** 点赞计数键的前缀。全项目唯一来源，调用点不拼字符串。 */
const REACTION_COUNT_KEY_PREFIX = 'community:post:';

/**
 * 计数的存活时间（秒）。改它等于改「数字最多能错多久」。
 *
 * 与 `@xsu/core` 的 `COMMUNITY_QUOTA_WINDOW_MS` 无关：那个是配额窗口，这个是缓存新鲜度，
 * 两个数字碰巧都在「一分钟」这个量级上没有任何含义。
 */
export const REACTION_COUNT_TTL_SECONDS = 60;

/**
 * 一个帖子的点赞计数键：`community:post:{id}:likes`。
 *
 * 键里带 `likes` 而不是只留帖子 id：点赞之外迟早会有别的计数（浏览数、收藏数），到那时不用改
 * 键格式就能并存，也不会把两类数字写到同一个键上。
 */
export function reactionCountKey(postId: string): string {
  return `${REACTION_COUNT_KEY_PREFIX}${postId}:likes`;
}

/**
 * 「键在才改」的原子脚本。
 *
 * `KEYS[1]` 是计数键，`ARGV[1]` 是增量（`1` 或 `-1`）。返回 `-1` 表示键不在、什么都没做；
 * 返回值本身不需要，领域层的 `ReactionCountPort` 只要 `Promise<void>`。
 */
const ADJUST_IF_PRESENT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return -1
end
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if value < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return value
`;

/**
 * 计数缓存的能力集合。
 *
 * **继承领域层的 `ReactionCountPort`**：这样 `packages/platform/src/community.ts` 把本对象直接
 * 接进 `CommunityPorts.reactions` 时，缺一个方法或签名不匹配都会在编译期报错，而不是等到线上
 * 点赞时才发现「计数没动」。
 */
export type ReactionCountCache = ReactionCountPort & {
  /** 批量读。**只返回缓存里确有的键**，缺的键由调用方去数据库算（缓存读失败时同样返回空表）。 */
  getMany: (postIds: string[]) => Promise<Map<string, number>>;
  /** 把数据库算出来的值写进缓存并设定存活时间。重复写同一个键是正常路径（重建）。 */
  setMany: (counts: Map<string, number>) => Promise<void>;
  /** 关掉连接。给测试与进程退出用。 */
  close: () => Promise<void>;
};

export type ReactionCountCacheDeps = {
  env: ServerEnv;
  /** 缓存故障记在哪里。默认写 stdout，与队列/worker 同一个出口；测试可换成收集数组。 */
  log?: (line: string) => void;
};

/** 一行一条、写 stdout。与 `apps/web/worker/index.ts` 的 `log` 同一格式。 */
function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 一次「失败也不影响结果」的缓存调用。
 *
 * 三条纪律：不往外抛（理由见文件头第一条）、不静默（失败必记一行）、不伪装成功（返回 `undefined`
 * 就是「这次没读到/没写成」，调用方必须自己处理这个分支，而不是拿到一个看起来正常的空值）。
 */
async function bestEffort<T>(
  log: (line: string) => void,
  what: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    log(
      `[cache] ${what}失败，已忽略（计数稍后由数据库重建）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * 建一个独立的计数缓存。**每次调用都会新建一条 Redis 连接**，所以只给「需要独立实例」的场合用
 * （测试、一次性脚本）；应用路径一律走 `getReactionCountCache`。
 */
export function createReactionCountCache(deps: ReactionCountCacheDeps): ReactionCountCache {
  const log = deps.log ?? writeStdout;

  let client: Redis | undefined;

  /** 懒建连接：`import` 本模块不连 Redis（与队列文件头第三条同一条理由）。 */
  function connection(): Redis {
    client ??= connect(deps.env, log);
    return client;
  }

  /** 所有写路径共用的加减。`delta` 只有两种取值，用联合类型把它们钉住。 */
  async function adjust(postId: string, delta: 1 | -1): Promise<void> {
    await bestEffort(log, delta > 0 ? '计数 +1' : '计数 -1', () =>
      connection().eval(ADJUST_IF_PRESENT, 1, reactionCountKey(postId), delta),
    );
  }

  return {
    async getMany(postIds) {
      const counts = new Map<string, number>();
      // 空入参不查：`mget` 不接受零个键（`ERR wrong number of arguments`）。
      if (postIds.length === 0) return counts;

      const values = await bestEffort(log, '批量读取', () =>
        connection().mget(...postIds.map(reactionCountKey)),
      );
      /*
       * 读失败（`undefined`）与没命中（值是 `null`）在这里合成同一个结果：空表。
       * 调用方拿到空表就去数据库算，这正是两条路都想要的下一步——不需要区分。
       */
      if (!values) return counts;

      postIds.forEach((postId, index) => {
        const raw = values[index];
        if (raw === null || raw === undefined) return;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isSafeInteger(parsed)) counts.set(postId, parsed);
      });

      return counts;
    },

    async setMany(entries) {
      if (entries.size === 0) return;

      await bestEffort(log, '回填', async () => {
        const pipeline = connection().pipeline();
        for (const [postId, value] of entries) {
          /*
           * 一个一个 `SET ... EX` 而不是 `MSET` + `EXPIRE`：后者两条命令之间有窗口，而
           * pipeline 把「写值」与「设存活时间」合成一次往返。**不检查每条命令的结果**——
           * `pipeline.exec()` 对命令级错误是 resolve 而不是 reject，而这里唯一可能的错误是
           * 「键写不进去」，它的后果是这次没加速、下次再算一遍，不值得为它多做一层判读。
           */
          pipeline.set(reactionCountKey(postId), value, 'EX', REACTION_COUNT_TTL_SECONDS);
        }
        await pipeline.exec();
      });
    },

    increment(postId) {
      return adjust(postId, 1);
    },

    decrement(postId) {
      return adjust(postId, -1);
    },

    async drop(postId) {
      /*
       * 内容被删除时用（`@xsu/core` 的 `deletePost`）：键本身没有错，只是再也没人会读它。
       * 留着也不会有问题（60 秒后自己过期），先删掉是为了让「内容没了，它的计数也不该在」
       * 在 Redis 里也成立。
       */
      await bestEffort(log, '丢弃计数', () => connection().del(reactionCountKey(postId)));
    },

    async close() {
      const instance = client;
      client = undefined;
      if (!instance || instance.status === 'end') return;

      try {
        await instance.quit();
      } catch {
        /*
         * 与 `./queue.ts` 的 `closeRedis` 同一处理：`quit` 需要能把命令发出去，连接已经断了
         * 的时候只剩强制断开一条路。退出流程只关心「进程能不能干净退出」。
         */
        instance.disconnect();
      }
    },
  };
}

/**
 * 建一条缓存连接。**必须有 `error` 监听**：ioredis 在没有监听者时把错误打到 `console.error`
 * （`ioredis@6.0.0` 的 `built/Redis.js` 第 561-587 行 `silentEmit`），不抛异常，但那句话不归
 * 我们的日志格式管。挂上自己的监听，让「Redis 连不上」在应用日志里也看得见。
 */
function connect(env: ServerEnv, log: (line: string) => void): Redis {
  const connection = new Redis(env.redis.url, {
    connectionName: 'xsu-cache',
    enableOfflineQueue: false,
  });

  connection.on('error', (error: Error) => {
    log(`[cache] Redis 连接异常（计数回落到数据库）：${error.message}`);
  });

  return connection;
}

/**
 * 进程内的共享缓存，按 Redis 地址区分。
 *
 * 与队列的 `producerQueues` 同一个写法与同一个理由：`getServerEnv()` 在一个进程里只解析一次，
 * 正常只有一个键；按地址缓存是为了让「不同配置各拿各的实例」在测试里也成立，而不是让第二次调用
 * 悄悄复用第一次的连接。
 */
const sharedCaches = new Map<string, ReactionCountCache>();

/** 取（或建）共享的计数缓存。**这是应用路径的唯一入口**，它不会为每次请求新建连接。 */
export function getReactionCountCache(env: ServerEnv): ReactionCountCache {
  const cached = sharedCaches.get(env.redis.url);
  if (cached) return cached;

  const created = createReactionCountCache({ env });
  sharedCaches.set(env.redis.url, created);
  return created;
}
