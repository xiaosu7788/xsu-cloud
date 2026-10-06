/**
 * 社交仓储的真库验证：`packages/db/src/repositories/social.ts` 在真实 Postgres 上跑一遍
 * 每条函数的语义，重点是被领域层依赖的那几个返回值。
 *
 * 为什么脚本而不是 vitest 用例：`packages/db` 没有 tests 目录（仓储语义靠 e2e 与这类脚本守），
 * 而这份验证需要真库、真约束（部分唯一索引、复合主键、`ON CONFLICT ... WHERE`），
 * 假仓储测不到这些。
 *
 * 与 [`scripts/verify-social-gateway.ts`](verify-social-gateway.ts) 的分工：那份验**装配**（领域端口
 * 接到了哪个仓储函数上、六个功能组在真库上跑完整流程得出什么结论），本份验**仓储**的约束行为与
 * 返回值语义。仓储各自正确、但端口接错（例如 `transactionId` 接到了 `dedupKey` 上）只有网关那一层
 * 看得见；反过来，装配对了也可能被某条 SQL 的边界悄悄破掉。两层都要跑，步骤见 `docs/TESTING.md` 第 5.4 节。
 * 断言的是**返回值语义**，不是 SQL 文本：
 *   - 幂等插入返回「这次真的插了吗」（撞约束 → false）
 *   - `applyPointTransaction` 撞键时 `applied:false` 且余额不动，流水快照回写正确
 *   - 私信读取方向不能反（标记已读只影响收件人）
 *   - `recordSpaceVisit` 的节流边界与领域层 `shouldCountVisit` 同界（含等号）
 *
 * 用法（容器 xsu-postgres 需在跑）：
 *   pnpm exec tsx scripts/verify-social-repo.ts
 *
 * 退出码 0 = 全部断言通过；1 = 有 FAIL（逐条打印 actual / expected）。
 * 种下的两个一次性用户在结束时级联删除。
 */
import {
  applyPointTransaction,
  countUnreadMessages,
  countUnreadNotifications,
  createDbClient,
  findDmContact,
  findLatestCheckin,
  findSpaceSettings,
  findSpaceStats,
  getPointBalance,
  insertAchievementUnlocks,
  insertCheckin,
  insertDmContact,
  insertDirectMessage,
  insertNotification,
  listAchievementUnlocks,
  listConversationMessages,
  listNotificationsForUser,
  listPendingDmRequests,
  listPointTransactions,
  listRecentCheckins,
  markConversationRead,
  markNotificationsRead,
  recordSpaceVisit,
  updateDmContactStatus,
  upsertSpaceSettings,
  user,
} from '../packages/db/src/index';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}｜actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

const stamp = Date.now().toString(36);
const userA = `social-verify-a-${stamp}`;
const userB = `social-verify-b-${stamp}`;

const t1 = new Date('2026-01-01T10:00:00.000Z');
const t2 = new Date('2026-01-01T10:00:01.000Z');
const t3 = new Date('2026-01-01T10:00:02.000Z');
const HOUR = 60 * 60 * 1000;

const n1 = `${stamp}-n1`;
const n2 = `${stamp}-n2`;
const n3 = `${stamp}-n3`;
const n4 = `${stamp}-n4`;

const { client, db } = createDbClient({ max: 1 });

/*
 * 裸 SQL 只用于**验证脚本自己的取证查询**（数行数、看流水快照、回拨节流窗口），不参与仓储实现。
 * 走驱动（postgres.js `unsafe`）而不是 `drizzle-orm` 的 `sql` 模板：根 `node_modules` 里没有
 * `drizzle-orm`（pnpm 隔离依赖），直接 import 会 ERR_MODULE_NOT_FOUND；本脚本只 import 各包的
 * **源文件**，让它们各自解析自己的依赖。
 * 裸查询复用仓储那一个连接池，参数化交给驱动。注意**时间参数必须显式**：postgres.js
 * 不认裸 `Date` 参数（`ERR_INVALID_ARG_TYPE`，`Buffer.byteLength` 收到 Date），仓储存
 * 时间靠 drizzle 列类型映射绕开了这一层；这里按同样口径传 ISO 串并 `::timestamptz`。
 */
async function raw(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await client.unsafe(query, params as never)) as unknown as Record<string, unknown>[];
}

async function main(): Promise<void> {
  await db.insert(user).values([
    { id: userA, name: 'verify-a', email: `${userA}@verify.local` },
    { id: userB, name: 'verify-b', email: `${userB}@verify.local` },
  ]);

  /* ---------------- 通知 ---------------- */
  const notification = (id: string, dedupKey: string | null, category: 'social' | 'system') => ({
    id,
    recipientId: userA,
    category,
    type: category === 'social' ? 'post_like' : 'site_notice',
    actorId: category === 'social' ? userB : null,
    postId: null,
    commentId: null,
    link: '/community/x',
    title: '标题',
    body: null,
    dedupKey,
    createdAt: t1,
  });

  check(
    'notify 首次插入',
    await insertNotification(db, notification(n1, `like:${stamp}`, 'social')),
    true,
  );
  check(
    'notify 同 dedupKey 换个 id 再插（撞部分唯一索引）',
    await insertNotification(db, notification(`${stamp}-n1b`, `like:${stamp}`, 'social')),
    false,
  );
  check(
    'notify 不同 dedupKey',
    await insertNotification(db, notification(n2, `like:${stamp}:2`, 'social')),
    true,
  );
  check(
    'notify dedupKey=null 第一条',
    await insertNotification(db, notification(n3, null, 'system')),
    true,
  );
  check(
    'notify dedupKey=null 第二条（部分索引不覆盖）',
    await insertNotification(db, notification(n4, null, 'system')),
    true,
  );

  check('notify 未读条数（自己的）', await countUnreadNotifications(db, userA), 4);
  check('notify 未读条数（别人的视图）', await countUnreadNotifications(db, userB), 0);

  const socialPage = await listNotificationsForUser(db, {
    userId: userA,
    category: 'social',
    limit: 10,
    cursorCreatedAt: null,
    cursorId: null,
  });
  check(
    'notify 按 category 筛选',
    socialPage.map((row) => row.id),
    [n2, n1],
  );

  const pageOne = await listNotificationsForUser(db, {
    userId: userA,
    category: null,
    limit: 2,
    cursorCreatedAt: null,
    cursorId: null,
  });
  check(
    'notify 第一页（limit 2）',
    pageOne.map((row) => row.id),
    [n4, n3],
  );

  const cursorRow = pageOne[1]!;
  const pageTwo = await listNotificationsForUser(db, {
    userId: userA,
    category: null,
    limit: 2,
    cursorCreatedAt: cursorRow.createdAt,
    cursorId: cursorRow.id,
  });
  check(
    'notify 第二页（游标续翻，不重不漏）',
    pageTwo.map((row) => row.id),
    [n2, n1],
  );

  check(
    'notify 标记一条',
    await markNotificationsRead(db, { userId: userA, ids: [n1], now: t2 }),
    1,
  );
  check(
    'notify 重复标同一条',
    await markNotificationsRead(db, { userId: userA, ids: [n1], now: t2 }),
    0,
  );
  check(
    'notify 空数组短路',
    await markNotificationsRead(db, { userId: userA, ids: [], now: t2 }),
    0,
  );
  check(
    'notify 拿别人的 id 也标不到（user_id 条件）',
    await markNotificationsRead(db, { userId: userB, ids: [n2], now: t2 }),
    0,
  );
  check('notify 未读剩 3', await countUnreadNotifications(db, userA), 3);
  check(
    'notify 全部已读',
    await markNotificationsRead(db, { userId: userA, ids: null, now: t3 }),
    3,
  );
  check('notify 全部已读后未读为 0', await countUnreadNotifications(db, userA), 0);

  /* ---------------- 积分 ---------------- */
  check('points 无记录时余额为 0', await getPointBalance(db, userA), 0);

  const apply = (id: string, delta: number, dedupKey: string | null, now: Date) =>
    applyPointTransaction(db, {
      id,
      userId: userA,
      delta,
      reason: delta > 0 ? 'checkin' : 'admin',
      detail: delta > 0 ? '每日签到' : '纠正错误发放',
      dedupKey,
      createdBy: null,
      now,
    });

  const p1 = `${stamp}-p1`;
  check('points 首次发放', await apply(p1, 5, `checkin:${stamp}`, t1), {
    applied: true,
    balance: 5,
  });
  check(
    'points 同 dedupKey 重复发放（撞键，余额不动）',
    await apply(`${stamp}-p1b`, 5, `checkin:${stamp}`, t2),
    {
      applied: false,
      balance: 5,
    },
  );
  check('points 管理员扣减', await apply(`${stamp}-p2`, -2, `admin:${stamp}`, t2), {
    applied: true,
    balance: 3,
  });
  check('points 余额 = 事实来源', await getPointBalance(db, userA), 3);

  const ledger = await raw(
    'select delta, balance from point_transactions where user_id = $1 order by created_at asc',
    [userA],
  );
  check('points 流水快照已回写真实余额', ledger, [
    { delta: 5, balance: 5 },
    { delta: -2, balance: 3 },
  ]);
  check(
    'points 撞键那一笔没有留下流水',
    await raw('select count(*)::int as n from point_transactions where user_id = $1', [userA]),
    [{ n: 2 }],
  );

  const txPage = await listPointTransactions(db, { userId: userA, limit: 10 });
  check(
    'points 流水倒序（最近一笔在最上）',
    txPage.map((row) => row.delta),
    [-2, 5],
  );
  check('points 流水带 detail', txPage[0]?.detail, '纠正错误发放');

  /* ---------------- 签到 ---------------- */
  const checkin = (checkinDate: string, streak: number, now: Date) =>
    insertCheckin(db, {
      userId: userA,
      checkinDate,
      points: 5,
      basePoints: 5,
      bonusPoints: 0,
      streak,
      now,
    });

  check('checkin 首次签到', await checkin('2026-01-01', 1, t1), true);
  check('checkin 同一天再签（撞主键）', await checkin('2026-01-01', 1, t2), false);
  check('checkin 第二天签到', await checkin('2026-01-02', 2, t2), true);
  check(
    'checkin 最近一次（站点时区日历日倒序）',
    (await findLatestCheckin(db, userA))?.checkinDate,
    '2026-01-02',
  );
  check('checkin 最近一次带连续天数', (await findLatestCheckin(db, userA))?.streak, 2);
  check(
    'checkin 最近若干次',
    (await listRecentCheckins(db, { userId: userA, limit: 10 })).map((row) => row.checkinDate),
    ['2026-01-02', '2026-01-01'],
  );
  check('checkin 没签过的人是 null', await findLatestCheckin(db, userB), null);

  /* ---------------- 私信 ---------------- */
  check(
    'dm 建申请行（owner=收件人，peer=发起人）',
    await insertDmContact(db, { ownerId: userA, peerId: userB, now: t1 }),
    true,
  );
  check(
    'dm 重复建行（撞主键）',
    await insertDmContact(db, { ownerId: userA, peerId: userB, now: t2 }),
    false,
  );
  check(
    'dm 查关系',
    (await findDmContact(db, { ownerId: userA, peerId: userB }))?.status,
    'request',
  );
  check(
    'dm 反方向查不到（方向有语义）',
    await findDmContact(db, { ownerId: userB, peerId: userA }),
    null,
  );
  check('dm 我收到的待处理申请', (await listPendingDmRequests(db, userA)).length, 1);
  check('dm 发起人那边没有待处理', (await listPendingDmRequests(db, userB)).length, 0);

  await updateDmContactStatus(db, { ownerId: userA, peerId: userB, status: 'accepted', now: t2 });
  check(
    'dm 同意后状态',
    (await findDmContact(db, { ownerId: userA, peerId: userB }))?.status,
    'accepted',
  );
  await updateDmContactStatus(db, { ownerId: userA, peerId: userB, status: 'declined', now: t3 });
  check(
    'dm 已处理的申请不会被后到的决定覆盖（where status=request）',
    (await findDmContact(db, { ownerId: userA, peerId: userB }))?.status,
    'accepted',
  );

  await insertDirectMessage(db, {
    id: `${stamp}-m1`,
    fromUserId: userA,
    toUserId: userB,
    body: 'A 发的',
    now: t1,
  });
  await insertDirectMessage(db, {
    id: `${stamp}-m2`,
    fromUserId: userB,
    toUserId: userA,
    body: 'B 发的',
    now: t2,
  });
  await insertDirectMessage(db, {
    id: `${stamp}-m3`,
    fromUserId: userB,
    toUserId: userA,
    body: 'B 发的第二句',
    now: t2,
  });

  const conversation = await listConversationMessages(db, {
    viewerId: userA,
    peerId: userB,
    limit: 10,
  });
  check(
    'dm 会话取双向且时间倒序',
    conversation.map((row) => row.body),
    ['B 发的第二句', 'B 发的', 'A 发的'],
  );
  check('dm 我收的未读', await countUnreadMessages(db, userA), 2);
  check('dm 对方收的未读', await countUnreadMessages(db, userB), 1);
  check(
    'dm 标记会话已读（只标对方发给我的）',
    await markConversationRead(db, { viewerId: userA, peerId: userB, now: t3 }),
    2,
  );
  check(
    'dm 重复标记已读',
    await markConversationRead(db, { viewerId: userA, peerId: userB, now: t3 }),
    0,
  );
  check('dm 我这边未读清零', await countUnreadMessages(db, userA), 0);
  check('dm 对方的未读没被反向标掉', await countUnreadMessages(db, userB), 1);
  const afterRead = await listConversationMessages(db, {
    viewerId: userA,
    peerId: userB,
    limit: 10,
  });
  check(
    'dm 已读的是「我收的」那两条',
    afterRead.slice(0, 2).map((row) => row.readAt !== null),
    [true, true],
  );
  check('dm 我发出去的那条没有被标已读', afterRead[2]?.readAt, null);

  /* ---------------- 空间 ---------------- */
  check('space 没设置过是 null', await findSpaceSettings(db, userA), null);
  check('space 没访问过是 null', await findSpaceStats(db, userA), null);

  check('space 头一次访问必计', await recordSpaceVisit(db, { userId: userA, now: t1 }), true);
  check(
    'space 一小时内不重复计',
    await recordSpaceVisit(db, { userId: userA, now: new Date(t1.getTime() + 60_000) }),
    false,
  );
  check('space 访问数只加了 1', (await findSpaceStats(db, userA))?.visitCount, 1);
  check(
    'space 上次计入时间已推进',
    (await findSpaceStats(db, userA))?.lastVisitAt?.getTime(),
    t1.getTime(),
  );

  // 回拨到 2 小时前：超过窗口，该重新计
  await raw('update user_stats set last_visit_at = $1::timestamptz where user_id = $2', [
    new Date(t1.getTime() - 2 * HOUR).toISOString(),
    userA,
  ]);
  check('space 超过窗口重新计', await recordSpaceVisit(db, { userId: userA, now: t1 }), true);
  check('space 访问数变 2', (await findSpaceStats(db, userA))?.visitCount, 2);

  // 边界：正好一小时（领域层是 >= 窗口，这里必须等价）
  await raw('update user_stats set last_visit_at = $1::timestamptz where user_id = $2', [
    new Date(t1.getTime() - HOUR).toISOString(),
    userA,
  ]);
  check(
    'space 正好一小时（边界与领域层同界，算计入）',
    await recordSpaceVisit(db, { userId: userA, now: t1 }),
    true,
  );

  await upsertSpaceSettings(db, {
    userId: userA,
    settings: { showStats: false, showPosts: true, showAchievements: false, motto: '一句话签名' },
    now: t2,
  });
  check('space 设置落库', await findSpaceSettings(db, userA), {
    showStats: false,
    showPosts: true,
    showAchievements: false,
    motto: '一句话签名',
  });

  await upsertSpaceSettings(db, {
    userId: userA,
    settings: { showStats: true, showPosts: false, showAchievements: true, motto: null },
    now: t3,
  });
  check('space 二次保存是覆盖而不是新行', await findSpaceSettings(db, userA), {
    showStats: true,
    showPosts: false,
    showAchievements: true,
    motto: null,
  });
  check(
    'space 设置表只有一行',
    await raw('select count(*)::int as n from user_spaces where user_id = $1', [userA]),
    [{ n: 1 }],
  );

  /* ---------------- 成就 ---------------- */
  await insertAchievementUnlocks(db, []);
  check('achievement 空数组是合法的空操作', true, true);

  await insertAchievementUnlocks(db, [
    { userId: userA, achievementId: 'posts-10', level: 1, now: t1 },
    { userId: userA, achievementId: 'posts-10', level: 2, now: t2 },
  ]);
  await insertAchievementUnlocks(db, [
    { userId: userA, achievementId: 'posts-10', level: 1, now: t3 },
  ]);
  check('achievement 重复解锁不新增行', (await listAchievementUnlocks(db, userA)).length, 2);
  check(
    'achievement 解锁记录按时间正序',
    (await listAchievementUnlocks(db, userA)).map((row) => row.level),
    [1, 2],
  );
  check('achievement 没解锁的人是空', await listAchievementUnlocks(db, userB), []);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.log('FAIL 脚本抛出异常（仓储层有未处理的情况）');
  console.log(error);
} finally {
  // 级联删除：社交九表都是 on delete cascade，删用户即清干净
  const removed = (
    await raw('delete from "user" where id in ($1, $2) returning id', [userA, userB])
  ).length;
  console.log(`清理一次性用户：删除 ${JSON.stringify(removed)} 行（社交九表级联）`);
  await client.end();
}

console.log(failures === 0 ? `全部通过（${stamp}）` : `失败 ${failures} 条（${stamp}）`);
process.exit(failures === 0 ? 0 : 1);
