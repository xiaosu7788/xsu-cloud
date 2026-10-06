/**
 * 社交网关（`packages/platform/src/social.ts`）的真库回归。
 *
 * ## 与 `scripts/verify-social-repo.ts` 的分工
 *
 * 那份脚本验**仓储**：每条 SQL 的约束行为、幂等、返回值的语义边界。
 * 本脚本验**装配**：`createSocialPorts` 把领域层的每一组端口接到了哪个仓储函数上，
 * 以及 `@xsu/core` 的 `src/social/` 在真库上跑完整流程能不能得出对的结果。
 *
 * 两层都要跑：仓储各自正确、但端口接错（例如 `transactionId` 接到 `dedupKey` 上、
 * 通知端口的 `now` 没翻译成 `createdAt`、`lastFromViewer` 取反了方向）只有这一层看得见；
 * 反过来，装配对了也可能被某条 SQL 的边界悄悄破掉。见 `docs/TESTING.md` 第 5.4 节。
 *
 * 用法（需要 `xsu-postgres` 在跑）：
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm exec tsx scripts/verify-social-gateway.ts
 *
 * ## 三个约定，写在前面
 *
 * 1. **时间由脚本注入**（`deps.now`）：所有写库时间都来自一个可控的假时钟，步骤之间显式
 *    `tick()`。这样「谁的会话排在前面」「节流窗口过没过」这类断言不依赖真实时钟，
 *    而且断言与写入看到的是同一个时间点。基准时刻特意选在 UTC 的 2024-01-01 16:30 ——
 *    站点时区（UTC+8）已经是 1 月 2 日，用来钉住「签到按站点日历日、不按 UTC 日期」
 *    这条最容易写错的规则（`packages/core/src/social/types.ts` 的日期口径）。
 * 2. **三个一次性用户**，跑完再删：社交九表的外键全是 `on delete cascade`，删用户即清场。
 *    邮箱带时间戳后缀，与真实数据零交集；脚本末端再数一遍九张表的残留行数确认删干净。
 * 3. 走 `@xsu` 各包的**源文件**而不是包名（仓库根不装依赖，同 `scripts/grant-admin.ts`）：
 *    顺带让 typecheck 检查平台层与领域层的接线是否真的对得上。
 *
 * 退出码 0 = 全部断言通过；1 = 有 FAIL（逐条打印 actual / expected）。
 */
import {
  ADMIN_ROLE,
  CHECKIN_BASE_POINTS,
  DM_BODY_MAX_CHARS,
  MOTTO_MAX_CHARS,
  SOCIAL_FAILURE,
  VISIT_THROTTLE_MS,
  applyPoints,
  checkin,
  countUnreadMessages,
  countUnreadNotifications,
  getCheckinStatus,
  getPointsBalance,
  getSpaceSettings,
  getSpaceStats,
  listAchievementProgress,
  listNotifications,
  listPendingRequests,
  listPointTransactions,
  listUnlocks,
  markNotificationsRead,
  notify,
  persistUnlocks,
  readConversation,
  recordSpaceVisit,
  reviewContactRequest,
  saveSpaceSettings,
  sendMessage,
  spaceSectionsFor,
  type SocialPageOutcome,
} from '../packages/core/src/index';
import { createDbClient, user } from '../packages/db/src/index';
import { ensureDotEnvLoaded } from '../packages/platform/src/env';
import { createSocialPorts } from '../packages/platform/src/social';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}｜actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

/** 失败码取值：`ok: false` 时给 `code`，成功给 null，省掉每个调用点的类型收窄。 */
function failureCodeOf(result: { ok: boolean }): string | null {
  return result.ok
    ? null
    : ((result as { failure?: { code?: string } }).failure?.code ?? 'NO_FAILURE');
}

/** 分页结果取值。`ok: false` 不该出现（领域层只在这一处返回它），当成 null 由断言报错。 */
function pageOf<T>(
  outcome: SocialPageOutcome<T>,
): { items: T[]; nextCursor: string | null } | null {
  return outcome.ok ? { items: outcome.items, nextCursor: outcome.nextCursor } : null;
}

ensureDotEnvLoaded();

const stamp = Date.now().toString(36);
const owner = { id: `gw-owner-${stamp}`, name: '网关验证·主人' };
const peer = { id: `gw-peer-${stamp}`, name: '网关验证·对端' };
const admin = { id: `gw-admin-${stamp}`, name: '网关验证·管理员' };

/*
 * 假时钟：所有写库时间都来自这里（`deps.now`）。基准 = UTC 2024-01-01 16:30，
 * 站点日历日已经是 1 月 2 日。
 */
const BASE_MS = Date.parse('2024-01-01T16:30:00.000Z');
let clockMs = BASE_MS;
const now = (): Date => new Date(clockMs);
const tick = (ms = 1000): void => {
  clockMs += ms;
};

let idSeq = 0;
const newId = (): string => `${stamp}-id-${(idSeq += 1)}`;

const { client, db } = createDbClient({ max: 1 });

/** 裸 SQL 只用于本脚本自己的取证（清场计数），不参与仓储实现。 */
async function raw(query: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await client.unsafe(query, params as never)) as unknown as Array<Record<string, unknown>>;
}

/** 社交九表 + 各自的用户列（清场计数用；表名是本脚本里的字面量，不来自外部输入）。 */
const SOCIAL_TABLES: Array<{ table: string; columns: readonly string[] }> = [
  { table: 'daily_checkins', columns: ['user_id'] },
  { table: 'direct_messages', columns: ['from_user_id', 'to_user_id'] },
  { table: 'dm_contacts', columns: ['owner_id', 'peer_id'] },
  { table: 'notifications', columns: ['recipient_id'] },
  { table: 'point_transactions', columns: ['user_id'] },
  { table: 'user_achievements', columns: ['user_id'] },
  { table: 'user_points', columns: ['user_id'] },
  { table: 'user_spaces', columns: ['user_id'] },
  { table: 'user_stats', columns: ['user_id'] },
];

async function main(): Promise<void> {
  await db.insert(user).values([
    { id: owner.id, name: owner.name, email: `${owner.id}@verify.local` },
    { id: peer.id, name: peer.name, email: `${peer.id}@verify.local` },
    { id: admin.id, name: admin.name, email: `${admin.id}@verify.local`, role: ADMIN_ROLE },
  ]);

  const gw = createSocialPorts({ userId: owner.id, db, now, newId });
  const anon = createSocialPorts({ db, now, newId });

  /* ---------------- 装配本身 ---------------- */

  check(
    '端口与页面读取都是函数（六个端口 + 四个读取）',
    [
      gw.notifications.create,
      gw.notifications.listForUser,
      gw.notifications.countUnread,
      gw.notifications.markRead,
      gw.points.apply,
      gw.points.getBalance,
      gw.points.listTransactions,
      gw.checkins.insert,
      gw.checkins.findLatest,
      gw.checkins.listRecent,
      gw.messages.insert,
      gw.messages.listConversation,
      gw.messages.markConversationRead,
      gw.messages.countUnread,
      gw.messages.listPendingRequests,
      gw.messages.findContact,
      gw.messages.insertContact,
      gw.messages.updateContactStatus,
      gw.space.findSettings,
      gw.space.upsertSettings,
      gw.space.recordVisit,
      gw.space.findStats,
      gw.achievements.insertUnlocks,
      gw.achievements.listUnlocks,
      gw.authorSummaries,
      gw.isAdminUser,
      gw.dmThreads,
      gw.unreadSummary,
    ].map((member) => typeof member),
    Array.from({ length: 28 }, () => 'function'),
  );

  check(
    '注入的 now / newId 被端口采纳',
    [gw.now().getTime(), gw.newId() !== gw.newId()],
    [BASE_MS, true],
  );

  /* ---------------- 通知：写入幂等、列表、游标分页、已读 ---------------- */

  check(
    'notify 首次写入返回 true',
    await notify(gw, {
      recipientId: owner.id,
      category: 'social',
      type: 'post_like',
      actorId: peer.id,
      targetId: 'gw-target-1',
      link: '/community/x',
      title: '有人赞了你',
    }),
    true,
  );

  check(
    'notify 同 type/target/actor 再写返回 false（dedupKey 自动推导）',
    await notify(gw, {
      recipientId: owner.id,
      category: 'social',
      type: 'post_like',
      actorId: peer.id,
      targetId: 'gw-target-1',
      link: '/community/x',
      title: '有人赞了你',
    }),
    false,
  );

  check(
    'notify 自己给自己：不写行',
    await notify(gw, {
      recipientId: owner.id,
      category: 'social',
      type: 'post_like',
      actorId: owner.id,
      targetId: 'gw-target-1',
      title: '自己赞自己',
    }),
    false,
  );

  tick(2000);
  check(
    'notify 第二条（不同 type）写入',
    await notify(gw, {
      recipientId: owner.id,
      category: 'social',
      type: 'post_comment',
      actorId: peer.id,
      targetId: 'gw-target-2',
      title: '有人评论了你',
    }),
    true,
  );

  check(
    '未读通知数 = 2（两条 false 都没写行）',
    await countUnreadNotifications(gw, {
      userId: owner.id,
    }),
    2,
  );

  const socialOnly = pageOf(await listNotifications(gw, { userId: owner.id, category: 'social' }));
  const systemOnly = pageOf(await listNotifications(gw, { userId: owner.id, category: 'system' }));
  check(
    '列表按分类过滤：social 两条、system 空',
    [socialOnly?.items.length, systemOnly?.items.length],
    [2, 0],
  );

  const page1 = pageOf(await listNotifications(gw, { userId: owner.id, category: null, limit: 1 }));
  check(
    '游标分页第 1 页：一条 + 有下一页（时间倒序，新的在前）',
    [page1?.items.length, page1?.nextCursor !== null, page1?.items[0]?.title],
    [1, true, '有人评论了你'],
  );

  const cursor = page1?.nextCursor ?? '';
  const [cursorIso, cursorId] = cursor.split('|');
  const page2 = pageOf(
    await listNotifications(gw, {
      userId: owner.id,
      category: null,
      limit: 1,
      cursorCreatedAt: new Date(cursorIso ?? ''),
      cursorId: cursorId ?? null,
    }),
  );
  check(
    '游标分页第 2 页：一条、无下一页、与第 1 页不重复',
    [
      page2?.items.length,
      page2?.nextCursor,
      page2?.items[0]?.title,
      page2?.items[0]?.id !== page1?.items[0]?.id,
    ],
    [1, null, '有人赞了你', true],
  );

  check(
    '标记全部已读返回标记条数，未读归零',
    [
      (await markNotificationsRead(gw, { userId: owner.id, ids: null })).marked,
      await countUnreadNotifications(gw, { userId: owner.id }),
    ],
    [2, 0],
  );

  /* ---------------- 积分：幂等发放与流水 ---------------- */

  const grant = await applyPoints(gw, {
    userId: owner.id,
    delta: 10,
    reason: 'admin_grant',
    detail: '网关验证',
    dedupKey: `gw-grant-${stamp}`,
  });
  check('applyPoints 发放 10：applied + 余额', [grant.applied, grant.balance], [true, 10]);

  const grantAgain = await applyPoints(gw, {
    userId: owner.id,
    delta: 10,
    reason: 'admin_grant',
    detail: '网关验证',
    dedupKey: `gw-grant-${stamp}`,
  });
  check(
    '同 dedupKey 再发：applied false 且余额不动',
    [grantAgain.applied, grantAgain.balance],
    [false, 10],
  );

  const freeHand = [
    await applyPoints(gw, { userId: owner.id, delta: 0, reason: 'badge', detail: '不去重' }),
    await applyPoints(gw, { userId: owner.id, delta: 0, reason: 'badge', detail: '不去重' }),
  ];
  check(
    'dedupKey 缺省（null）的两次发放各记一条流水',
    [freeHand.map((result) => result.applied), await getPointsBalance(gw, { userId: owner.id })],
    [[true, true], 10],
  );

  const transactions = await listPointTransactions(gw, { userId: owner.id });
  check(
    '流水三条、最新一条是刚发的、余额快照正确',
    [
      transactions.length,
      transactions[0]?.reason,
      transactions[0]?.balance,
      transactions.filter((row) => row.reason === 'admin_grant').length,
    ],
    [3, 'badge', 10, 1],
  );

  /* ---------------- 签到：站点日历日 + 发分幂等 ---------------- */

  tick();
  const firstCheckin = await checkin(gw, { userId: owner.id });
  check(
    '签到成功：日期按站点时区（UTC 是 1 月 1 日）、连续 1 天、发基础分',
    firstCheckin.ok
      ? [
          firstCheckin.value.checkinDate,
          firstCheckin.value.streak,
          firstCheckin.value.points,
          firstCheckin.value.balance,
        ]
      : failureCodeOf(firstCheckin),
    ['2024-01-02', 1, CHECKIN_BASE_POINTS, 10 + CHECKIN_BASE_POINTS],
  );

  const secondCheckin = await checkin(gw, { userId: owner.id });
  check(
    '同日再签：alreadyCheckedIn（409）且余额不变',
    [
      failureCodeOf(secondCheckin),
      SOCIAL_FAILURE.alreadyCheckedIn.code,
      await getPointsBalance(gw, { userId: owner.id }),
    ],
    [SOCIAL_FAILURE.alreadyCheckedIn.code, SOCIAL_FAILURE.alreadyCheckedIn.code, 15],
  );

  const status = await getCheckinStatus(gw, { userId: owner.id });
  check(
    '签到状态：今天已签、连续 1、累计 1、最近记录同日同分',
    [
      status.today,
      status.checkedInToday,
      status.streak,
      status.total,
      status.recent[0]?.checkinDate,
      status.recent[0]?.points,
    ],
    ['2024-01-02', true, 1, 1, '2024-01-02', CHECKIN_BASE_POINTS],
  );

  /* ---------------- 私信：申请三态 + 方向 + 未读窗口 ---------------- */

  tick();
  const firstMessage = await sendMessage(gw, {
    senderId: peer.id,
    recipientId: owner.id,
    recipientIsAdmin: false,
    body: '你好',
  });
  check(
    '无关系时第一条：放行并建申请',
    firstMessage.ok
      ? [firstMessage.value.createdRequest, typeof firstMessage.value.messageId === 'string']
      : failureCodeOf(firstMessage),
    [true, true],
  );

  check(
    '空正文被领域层挡下（网关不绕过校验）',
    failureCodeOf(
      await sendMessage(gw, {
        senderId: peer.id,
        recipientId: owner.id,
        recipientIsAdmin: true,
        body: '   ',
      }),
    ),
    SOCIAL_FAILURE.inputInvalid.code,
  );

  check(
    '超长正文被挡下',
    failureCodeOf(
      await sendMessage(gw, {
        senderId: peer.id,
        recipientId: owner.id,
        recipientIsAdmin: true,
        body: 'x'.repeat(DM_BODY_MAX_CHARS + 1),
      }),
    ),
    SOCIAL_FAILURE.inputTooLarge.code,
  );

  check(
    '第二条：dmPendingRequest（只准一条申请）',
    failureCodeOf(
      await sendMessage(gw, {
        senderId: peer.id,
        recipientId: owner.id,
        recipientIsAdmin: false,
        body: '再来一条',
      }),
    ),
    SOCIAL_FAILURE.dmPendingRequest.code,
  );

  const ownerPending = await listPendingRequests(gw, { viewerId: owner.id });
  check(
    '收件人看到一条待处理申请（方向：owner=收件人、peer=发起人）',
    [ownerPending.length, ownerPending[0]?.peerId, ownerPending[0]?.status],
    [1, peer.id, 'request'],
  );

  check(
    '私信通知落到收件人（dedupKey=null，对话类不去重）',
    [
      await countUnreadNotifications(gw, { userId: owner.id }),
      await countUnreadMessages(gw, {
        viewerId: owner.id,
      }),
    ],
    [1, 1],
  );

  const ownerConversation = await readConversation(gw, { viewerId: owner.id, peerId: peer.id });
  check(
    '读会话：一条、正文原样，读完自己的未读归零（对端的未读不受影响）',
    [
      ownerConversation.map((row) => [row.fromUserId === peer.id, row.body]),
      await countUnreadMessages(gw, { viewerId: owner.id }),
      await countUnreadMessages(gw, { viewerId: peer.id }),
    ],
    [[[true, '你好']], 0, 0],
  );

  check(
    '处理别人的申请：查不到「以我为收件人」的关系行 → inputInvalid',
    failureCodeOf(
      await reviewContactRequest(gw, {
        viewerId: admin.id,
        peerId: peer.id,
        decision: 'accepted',
      }),
    ),
    SOCIAL_FAILURE.inputInvalid.code,
  );

  check(
    '对自己处理申请：conversationForbidden',
    failureCodeOf(
      await reviewContactRequest(gw, { viewerId: peer.id, peerId: peer.id, decision: 'accepted' }),
    ),
    SOCIAL_FAILURE.conversationForbidden.code,
  );

  const accepted = await reviewContactRequest(gw, {
    viewerId: owner.id,
    peerId: peer.id,
    decision: 'accepted',
  });
  check(
    '收件人同意：状态转 accepted、待处理列表清空',
    [
      accepted.ok ? accepted.status : failureCodeOf(accepted),
      (
        await listPendingRequests(gw, {
          viewerId: owner.id,
        })
      ).length,
    ],
    ['accepted', 0],
  );

  const peerNotifications = pageOf(
    await listNotifications(gw, { userId: peer.id, category: 'social' }),
  );
  const peerNotificationId = peerNotifications?.items[0]?.id ?? '';
  check(
    '同意后发起者收到一条通知（类型 / 链接 / 未读）',
    [
      peerNotifications?.items.length,
      peerNotifications?.items[0]?.type,
      peerNotifications?.items[0]?.link,
      await countUnreadNotifications(gw, { userId: peer.id }),
    ],
    [1, 'dm_accepted', '/console/messages', 1],
  );

  check(
    '标记已读带别人的通知 id：只标记属于本人的（这次 0 条）',
    [
      (await markNotificationsRead(gw, { userId: owner.id, ids: [peerNotificationId] })).marked,
      await countUnreadNotifications(gw, { userId: peer.id }),
    ],
    [0, 1],
  );

  check(
    '重复处理同一条申请：状态已不是 request → inputInvalid',
    failureCodeOf(
      await reviewContactRequest(gw, { viewerId: owner.id, peerId: peer.id, decision: 'accepted' }),
    ),
    SOCIAL_FAILURE.inputInvalid.code,
  );

  tick();
  const acceptedMessage = await sendMessage(gw, {
    senderId: peer.id,
    recipientId: owner.id,
    recipientIsAdmin: false,
    body: '同意之后再来一条',
  });
  check(
    '同意之后继续发：不再建申请',
    acceptedMessage.ok
      ? [
          acceptedMessage.value.createdRequest,
          await countUnreadMessages(gw, { viewerId: owner.id }),
        ]
      : failureCodeOf(acceptedMessage),
    [false, 1],
  );

  tick();
  const reverseMessage = await sendMessage(gw, {
    senderId: owner.id,
    recipientId: peer.id,
    recipientIsAdmin: false,
    body: '我回你一条',
  });
  check(
    '反方向没有关系行：又是一条申请（一对人两个方向）',
    reverseMessage.ok ? reverseMessage.value.createdRequest : failureCodeOf(reverseMessage),
    true,
  );

  const declined = await reviewContactRequest(gw, {
    viewerId: peer.id,
    peerId: owner.id,
    decision: 'declined',
  });
  check(
    '对端拒绝反方向的申请',
    declined.ok ? declined.status : failureCodeOf(declined),
    'declined',
  );

  check(
    '被拒绝后再发：dmDeclined',
    failureCodeOf(
      await sendMessage(gw, {
        senderId: owner.id,
        recipientId: peer.id,
        recipientIsAdmin: false,
        body: '再试一次',
      }),
    ),
    SOCIAL_FAILURE.dmDeclined.code,
  );

  /* ---------------- 管理员豁免：布尔决定，不是旁路 ---------------- */

  check(
    'isAdminUser：管理员 true、普通用户 false、查无此人 false',
    [
      await gw.isAdminUser(admin.id),
      await gw.isAdminUser(owner.id),
      await gw.isAdminUser(`${stamp}-不存在`),
    ],
    [true, false, false],
  );

  tick();
  const toAdmin = await sendMessage(gw, {
    senderId: owner.id,
    recipientId: admin.id,
    recipientIsAdmin: true,
    body: '管理员你好',
  });
  check(
    '发给管理员：豁免，不建申请行',
    toAdmin.ok ? toAdmin.value.createdRequest : failureCodeOf(toAdmin),
    false,
  );

  tick();
  const toAdminNotMarked = await sendMessage(gw, {
    senderId: owner.id,
    recipientId: admin.id,
    recipientIsAdmin: false,
    body: '再看一条',
  });
  check(
    '同一个管理员，布尔传 false：走普通人路径（建申请）',
    toAdminNotMarked.ok ? toAdminNotMarked.value.createdRequest : failureCodeOf(toAdminNotMarked),
    true,
  );

  const adminPending = await listPendingRequests(gw, { viewerId: admin.id });
  check(
    '管理员的申请入口与普通人同一条路径',
    [adminPending.length, adminPending[0]?.peerId],
    [1, owner.id],
  );

  /* ---------------- 会话列表（一条 CTE 取每个对端最后一句 + 未读） ---------------- */

  const ownerThreads = await gw.dmThreads();
  check(
    '发起方的会话列表：两个对端、时间倒序、最后一句与未读同一次读取',
    ownerThreads.map((row) => [
      row.peerId === admin.id ? 'admin' : row.peerId === peer.id ? 'peer' : row.peerId,
      row.lastBody,
      row.lastFromViewer,
      row.unread,
    ]),
    [
      ['admin', '再看一条', true, 0],
      ['peer', '我回你一条', true, 1],
    ],
  );

  const limitedThreads = await gw.dmThreads(1);
  check('会话列表的 limit 生效', limitedThreads.length, 1);

  const anonThreads = await anon.dmThreads();
  check('未登录（未传 userId）：会话列表恒为空数组', anonThreads.length, 0);

  const peerViewThreads = await createSocialPorts({ userId: peer.id, db, now, newId }).dmThreads();
  check(
    '对端的视图：只有与主人这一条（看不到主人的其他对端），最后一句是主人发的、未读算收到的',
    peerViewThreads.map((row) => [
      row.peerId === owner.id ? 'owner' : row.peerId,
      row.lastBody,
      row.lastFromViewer,
      row.unread,
    ]),
    [['owner', '我回你一条', false, 1]],
  );

  /* ---------------- 未读合计（网关内算，两个数同一次读取） ---------------- */

  const ownerUnread = await createSocialPorts({ userId: owner.id, db, now, newId }).unreadSummary();
  check(
    '登录用户：未读通知 2（两条私信各写一条通知）+ 私信 1（只算未读的那条）= 3',
    [ownerUnread.notifications, ownerUnread.messages, ownerUnread.total],
    [2, 1, 3],
  );

  const adminUnread = await createSocialPorts({ userId: admin.id, db, now, newId }).unreadSummary();
  check(
    '管理员看到的两条私信（dedupKey=null 的通知不去重）',
    [adminUnread.notifications, adminUnread.messages, adminUnread.total],
    [2, 2, 4],
  );

  const anonUnread = await anon.unreadSummary();
  check(
    '未登录：两个未读数与合计全 0',
    [anonUnread.notifications, anonUnread.messages, anonUnread.total],
    [0, 0, 0],
  );

  /* ---------------- 作者摘要（空间页与列表页的展示读取） ---------------- */

  const summaries = await gw.authorSummaries([owner.id, peer.id, `${stamp}-不存在`]);
  check(
    '作者摘要：命中两人、缺的 id 不在返回值里',
    [summaries.get(owner.id)?.name, summaries.get(peer.id)?.name, summaries.size],
    [owner.name, peer.name, 2],
  );

  /* ---------------- 空间：设置、裁剪、访问节流 ---------------- */

  check('未设置过：默认三个分区全开、无签名', await getSpaceSettings(gw, { userId: owner.id }), {
    showStats: true,
    showPosts: true,
    showAchievements: true,
    motto: null,
  });

  check(
    '保存设置成功',
    (
      await saveSpaceSettings(gw, {
        userId: owner.id,
        showStats: false,
        showPosts: true,
        showAchievements: false,
        motto: '  一句话签名  ',
      })
    ).ok,
    true,
  );

  const saved = await getSpaceSettings(gw, { userId: owner.id });
  check(
    '读回设置：开关落库、签名去空白',
    [saved.showStats, saved.showPosts, saved.showAchievements, saved.motto],
    [false, true, false, '一句话签名'],
  );

  check(
    '分区裁剪：主人看自己无视开关（关掉的分区在领域层就不下发）',
    spaceSectionsFor({ viewerId: owner.id, ownerId: owner.id, settings: saved }),
    { stats: true, posts: true, achievements: true, motto: '一句话签名' },
  );

  check(
    '分区裁剪：访客按开关，posts 开着就是 true、另外两个 false',
    spaceSectionsFor({ viewerId: peer.id, ownerId: owner.id, settings: saved }),
    { stats: false, posts: true, achievements: false, motto: '一句话签名' },
  );

  check(
    '签名超长被挡下',
    failureCodeOf(
      await saveSpaceSettings(gw, {
        userId: owner.id,
        showStats: true,
        showPosts: true,
        showAchievements: true,
        motto: 'x'.repeat(MOTTO_MAX_CHARS + 1),
      }),
    ),
    SOCIAL_FAILURE.inputTooLarge.code,
  );

  await saveSpaceSettings(gw, {
    userId: owner.id,
    showStats: true,
    showPosts: true,
    showAchievements: true,
    motto: null,
  });
  check(
    '签名传 null：清空（读回 null，不是空串）',
    (await getSpaceSettings(gw, { userId: owner.id })).motto,
    null,
  );

  tick();
  check(
    '访问计数：首次计入、立刻再来不计（节流窗口内）',
    [
      await recordSpaceVisit(gw, { userId: owner.id }),
      await recordSpaceVisit(gw, {
        userId: owner.id,
      }),
    ],
    [true, false],
  );

  tick(VISIT_THROTTLE_MS + 1000);
  check(
    '访问计数：过了节流窗口再计一次，累计 2',
    [
      await recordSpaceVisit(gw, { userId: owner.id }),
      await getSpaceStats(gw, {
        userId: owner.id,
      }),
    ],
    [true, { visitCount: 2 }],
  );

  /* ---------------- 成就：纯计算 + 解锁落库幂等 ---------------- */

  const progress = listAchievementProgress({
    postCount: 0,
    commentCount: 0,
    checkinCount: 1,
    likesReceived: 0,
    visitCount: 2,
    currentStreak: 1,
  });
  const levelOf = (id: string): number | undefined =>
    progress.find((item) => item.id === id)?.level;
  check(
    '实时等级：累计签到 1 → 坚持 1 级；访问 2 → 常来 1 级；连签 1 → 未达标',
    [levelOf('checkin'), levelOf('visitor'), levelOf('streak')],
    [1, 1, 0],
  );

  check(
    '落库解锁（补 1..当前级）',
    await persistUnlocks(gw, { userId: owner.id, progress, existing: [] }),
    2,
  );

  const unlocks = await listUnlocks(gw, { userId: owner.id });
  check('读回解锁记录', unlocks.map((row) => [row.achievementId, row.level]).sort(), [
    ['checkin', 1],
    ['visitor', 1],
  ]);

  check(
    '再次落库：已有记录不再写（保留最早的解锁时间）',
    await persistUnlocks(gw, { userId: owner.id, progress, existing: unlocks }),
    0,
  );
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.log('FAIL 脚本抛出异常（装配或领域层有未处理的情况）');
  console.log(error);
} finally {
  const ids = [owner.id, peer.id, admin.id];
  try {
    const removed = (await raw('delete from "user" where id in ($1, $2, $3) returning id', ids))
      .length;
    console.log(`[清理] 一次性用户删除 ${JSON.stringify(removed)} 行（社交九表级联）`);

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
    let leftover = 0;
    for (const entry of SOCIAL_TABLES) {
      const where = entry.columns.map((column) => `${column} in (${placeholders})`).join(' or ');
      const rows = await raw(`select count(*)::int as n from "${entry.table}" where ${where}`, ids);
      leftover += Number(rows[0]?.n ?? 0);
    }
    /*
     * `notifications.actor_id` 是 `on delete set null`（不是 cascade）：这些行按收件人删掉了，
     * 但如果哪天有人改成只删动作方，这里会留下一堆 actor 为空的孤儿通知——单独数一遍。
     */
    const orphanRows = await raw(
      `select count(*)::int as n from "notifications" where actor_id in (${placeholders})`,
      ids,
    );
    check('清场：社交九表没有残留行', leftover, 0);
    check('清场：没有 actor 指向一次性用户的孤儿通知', Number(orphanRows[0]?.n ?? 0), 0);
  } catch (error) {
    failures += 1;
    console.log('FAIL 清场阶段出错（可能留下了测试数据，手工检查上面的三个 id）');
    console.log(error);
  } finally {
    await client.end();
  }
}

console.log(failures === 0 ? `全部通过（${stamp}）` : `失败 ${failures} 条（${stamp}）`);
process.exit(failures === 0 ? 0 : 1);
