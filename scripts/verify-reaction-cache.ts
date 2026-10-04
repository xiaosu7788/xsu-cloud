/**
 * 点赞计数缓存（`packages/platform/src/cache.ts`）的手工回归。
 *
 * 这是 [`docs/spec/SPEC-community.md`](../docs/spec/SPEC-community.md) 第 9 节「列表计数走 Redis」
 * 一行的落地形式：与队列同一纪律——提交级检查不起 Redis，`queue.test.ts` 因此只测纯分派逻辑；
 * 缓存同样只连真实 Redis 才验得了，所以写成脚本而不是「没有 Redis 就跳过」的用例
 * （那等于把现场状态藏起来，见 `queue.test.ts` 文件头）。
 *
 * 用法：
 *   docker compose -f docker/docker-compose.yml up -d   # 先有 Redis
 *   pnpm exec tsx scripts/verify-reaction-cache.ts
 *
 * 覆盖六条行为（对应 cache.ts 的三段文件头注释）：
 *   1. `setMany` 回填后 `getMany` 命中；
 *   2. 键在时 `increment` / `decrement` 生效（走 Lua「键在才改」）；
 *   3. **键不在时 `increment` 什么都不做**——不把真实值 5 改成 1 的关键防线；
 *   4. 减到负数夹回 0 且键保留（`KEEPTTL` 分支）；
 *   5. `drop` 后立即失效（`DEL`）；
 *   6. **Redis 连不上时 `getMany` 解析为空表而不是 reject**（best-effort 纪律，用一条
 *      指向空闲端口的地址实测，不靠 mock）。
 *
 * 键用 `community:post:verify-cache-<时间戳>:likes`，与真实数据零交集；60 秒 TTL 自动清理。
 * 退出码 0 = 全部断言通过；任一失败非零退出。
 */
import { getServerEnv } from '../packages/platform/src/index';
import { createReactionCountCache, reactionCountKey } from '../packages/platform/src/cache';

const failures: string[] = [];

/** 断言助手：失败记一条继续跑，最后统一非零退出——一次跑完全部现场比逐个修再跑省事。 */
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures.push(name);
}

const env = getServerEnv();
const postId = `verify-cache-${Date.now()}`;
const key = reactionCountKey(postId);
console.log(`[verify-cache] Redis：${new URL(env.redis.url).host}，键：${key}`);

const cache = createReactionCountCache({
  env,
  log: (line) => console.log(`  [cache日志] ${line}`),
});
/*
 * 等连接就绪。`enableOfflineQueue: false` 是 cache.ts 的有意取舍（快速失败、回落数据库），
 * 代价是连接建立**之前**发出的命令当场失败且被 best-effort 吞掉——应用里这只影响进程启动后
 * 的第一毫秒（共享连接长期存活），脚本里则必须显式等：轮询「写入 → 读回」直到成功。
 */
let ready = false;
for (let attempt = 1; attempt <= 50; attempt += 1) {
  await cache.setMany(new Map([[postId, 0]]));
  const probe = await cache.getMany([postId]);
  if (probe.get(postId) === 0) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('Redis 连接就绪（写入并读回一次）', ready);

/* 1. 回填 → 命中。 */
await cache.setMany(new Map([[postId, 5]]));
let got = await cache.getMany([postId]);
check('回填后 getMany 命中', got.get(postId) === 5, `读到 ${got.get(postId)}`);

/* 2. 键在：+1 / -1 生效。 */
await cache.increment(postId);
got = await cache.getMany([postId]);
check('键在时 increment 生效', got.get(postId) === 6, `读到 ${got.get(postId)}`);
await cache.decrement(postId);
got = await cache.getMany([postId]);
check('键在时 decrement 生效', got.get(postId) === 5, `读到 ${got.get(postId)}`);

/* 3. 键不在：increment 必须是空操作（否则重建前的 INCR 会把真实值改坏）。 */
const missingPostId = `${postId}-missing`;
await cache.increment(missingPostId);
got = await cache.getMany([missingPostId]);
check('键不在时 increment 不建键', got.size === 0, `返回 ${got.size} 项`);

/* 4. 负数夹回 0，键保留（KEEPTTL 分支）。 */
await cache.setMany(new Map([[`${postId}-zero`, 0]]));
await cache.decrement(`${postId}-zero`);
got = await cache.getMany([`${postId}-zero`]);
check(
  '减到负数夹回 0 且键保留',
  got.get(`${postId}-zero`) === 0,
  `读到 ${got.get(`${postId}-zero`)}`,
);

/* 5. drop 后立即失效。 */
await cache.drop(postId);
got = await cache.getMany([postId]);
check('drop 后 getMany 不再命中', got.size === 0);

/* 6. 连不上时解析为空表而不是 reject（用一条指向空闲端口的地址实测降级路径）。 */
const deadCache = createReactionCountCache({
  env: { ...env, redis: { url: 'redis://127.0.0.1:59999' } },
  log: (line) => console.log(`  [降级实例日志] ${line}`),
});
const degraded = await deadCache.getMany([postId]);
check('Redis 不可达时 getMany 返回空表而不是抛错', degraded.size === 0);
await deadCache.close();

await cache.close();
console.log(
  `[verify-cache] 完成：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项`}`,
);
if (failures.length > 0) {
  process.exitCode = 1;
}
