/**
 * M5 后台管理端到端回归：用户管理、内容管理、站点配置、任务管理。审计页是纯只读时间线，
 * 没有专属交互，它的行结构与「动作 + 目标 id」定位法在封禁 / 下架用例里顺带覆盖。
 *
 * 与 `community.spec.ts` 同一条编写约定：真实库、真实会话、随机内容，desktop / mobile
 * 两个 project 并发跑也不会互踩。三个并发防御：
 *
 * 1. **封禁 / 解封的受害者不共享账号**——每个用例（每个 project）邀请注册一个独立账号
 *    （邮箱含 project 名与随机后缀），从不登录、结束不解封。不用 `tools-seed.ts` 的
 *    「先删后建」：共享账号会被两个并发 project 互踩（封禁一边、另一边的行状态就变了），
 *    每轮新造的账号天然互不影响。
 * 2. **行定位器按视口选形态**：`ResponsiveTable` 在同一棵树里渲染桌面 `<table>`（`hidden
 *    md:block`）与移动卡片 `<ul><li>`（`md:hidden`），两份 DOM 并存——直接按文本过滤会把
 *    隐藏副本一起数进去。所以统一走 `viewportRow()`：宽视口取 `tr`、窄视口取 `li`。
 * 3. **站点配置的 0 = 关闭是瞬态**：`site_config` 是全局唯一行，评论配额存 0 会关闭
 *    所有用户的评论入口，与并发跑的 `community.spec.ts` 评论步骤互斥。所以用例先存
    (MAX, 0, 空) 断言回显，再立即存一次全空恢复默认语义，把 0 的存活窗口压缩到一次
 *    (MAX, 0, 空) 断言回显，再立即存一次全空恢复默认语义，把 0 的存活窗口压缩到一次
 *
 * 审计断言统一在 `/admin/audit` 按「动作名 + 目标 id」过滤行；audit 页每页 20 条，e2e 库
 * 的审计行远少于一页，直接断言即可。
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SITE_CONFIG_QUOTA_MAX, registerWithInvite } from '@xsu/core';
import { getDb, invites } from '@xsu/db';
import { createRegistrationPorts, ensureDotEnvLoaded, getAuth } from '@xsu/platform';

import { ADMIN_CONFIG, ADMIN_CONTENT, ADMIN_TASKS, ADMIN_USERS } from '@/features/admin/routes';
import { CONSOLE_COMMUNITY, communityPostPath } from '@/features/community/routes';

import { ADMIN, ADMIN_STORAGE, BASE_URL, NON_ADMIN_STORAGE } from './env';

test.use({ storageState: ADMIN_STORAGE });

/** 按视口选行定位器：宽视口取表格行 `tr`，窄视口取卡片 `li`（两份 DOM 并存，见文件头）。 */
function viewportRow(page: Page, text: string): Locator {
  const wide = page.locator('tr').filter({ hasText: text });
  const narrow = page.locator('li').filter({ hasText: text });
  const size = page.viewportSize();
  return size !== null && size.width < 768 ? narrow : wide;
}

/** 封禁用例的受害者档案：邮箱含 project 名与随机后缀，两视口并发也不撞车。 */
function banVictim(projectName: string) {
  const token = `${projectName}-${randomUUID().slice(0, 8)}`.toLowerCase();
  return {
    name: `e2e 封禁靶子 ${token}`,
    email: `e2e-ban-${token}@example.com`,
    password: `e2e-ban-${randomUUID()}`,
  };
}

/**
 * 真实邀请注册一个「从不登录」的账号并返回其 id。与 `admin-seed.ts` 同一条编排：
 * 邀请码 → `registerWithInvite` → 标记邮箱已验证；不标 role，默认就是 `user`。
 */
async function seedVictim(victim: ReturnType<typeof banVictim>): Promise<string> {
  ensureDotEnvLoaded();
  const db = getDb();
  const auth = getAuth();

  const code = `E2E-${randomUUID()}`;
  await db.insert(invites).values({ id: randomUUID(), code });

  const outcome = await registerWithInvite(createRegistrationPorts({ db, auth }), {
    name: victim.name,
    email: victim.email,
    password: victim.password,
    inviteCode: code,
  });
  if (!outcome.ok) {
    throw new Error(
      `端到端封禁靶子注册失败：${outcome.failure.code} ${outcome.failure.message}` +
        '（这条路径与用户注册相同，失败说明注册编排或环境配置有问题。）',
    );
  }

  await (
    await auth.$context
  ).internalAdapter.updateUserByEmail(victim.email, {
    emailVerified: true,
  });
  return outcome.userId;
}

/** 从审计页捞一行：按「动作中文名 + 目标 id」定位（targetId 在每行完整渲染）。 */
function auditRow(page: Page, actionLabel: string, targetId: string): Locator {
  return viewportRow(page, targetId).filter({ hasText: actionLabel });
}

test.describe('用户管理', () => {
  test('搜索、防自锁、封禁与解封全链路，每步留审计', async ({ page }, testInfo) => {
    const victim = banVictim(testInfo.project.name);
    const victimId = await seedVictim(victim);

    await page.goto(ADMIN_USERS);
    await expect(page.getByRole('heading', { level: 1, name: '用户管理' })).toBeVisible();

    /* 防自锁：搜出管理员自己，行内只有「当前登录者」文案，没有任何按钮。 */
    await page.getByLabel('搜索用户').fill(ADMIN.email);
    await page.getByRole('button', { name: '搜索' }).click();
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(ADMIN.email)}`));
    const selfRow = viewportRow(page, ADMIN.email);
    await expect(selfRow).toBeVisible();
    await expect(selfRow).toContainText('当前登录者');
    await expect(selfRow.getByRole('button')).toHaveCount(0);

    /* 封禁：展开 <details>，填理由，确认。 */
    await page.getByLabel('搜索用户').fill(victim.email);
    await page.getByRole('button', { name: '搜索' }).click();
    const row = viewportRow(page, victim.email);
    await expect(row).toBeVisible();
    await row.locator('summary').click();
    await row.getByLabel(`填写 ${victim.email} 的封禁理由`).fill(`e2e 封禁理由 ${victim.email}`);
    await row.getByRole('button', { name: '确认封禁' }).click();

    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(page.getByRole('status')).toHaveText('已封禁，该用户的全部会话已下线。');
    const bannedRow = viewportRow(page, victim.email);
    await expect(bannedRow).toContainText('封禁中');
    await expect(bannedRow).toContainText(`e2e 封禁理由 ${victim.email}`);

    await page.goto('/admin/audit');
    await expect(auditRow(page, '封禁用户', victimId)).toBeVisible();

    /* 解封：按钮直接在行内。 */
    await page.goto(ADMIN_USERS);
    await page.getByLabel('搜索用户').fill(victim.email);
    await page.getByRole('button', { name: '搜索' }).click();
    await viewportRow(page, victim.email).getByRole('button', { name: '解封' }).click();

    await expect(page.getByRole('status')).toHaveText('已解封，该用户需要重新登录。');
    await expect(viewportRow(page, victim.email)).toContainText('正常');

    await page.goto('/admin/audit');
    await expect(auditRow(page, '解封用户', victimId)).toBeVisible();
  });
});

test.describe('内容管理', () => {
  test('普通用户发帖后，管理员下架与恢复在公开侧立即可见，动作留审计', async ({
    browser,
  }, testInfo) => {
    /* 主视角用普通用户造帖（非管理员存储），管理动作切到管理员上下文。 */
    const nonAdminContext = await browser.newContext({
      baseURL: BASE_URL,
      storageState: NON_ADMIN_STORAGE,
    });
    const token =
      `admin-content-${testInfo.project.name}-${randomUUID().slice(0, 8)}`.toLowerCase();
    const title = `e2e 管理内容帖子 ${token}`;
    /* 标签受 POST_TAG_MAX_CHARS（24）限制，不能复用整个 token，另起短格式。 */
    const tag = `e2e-${randomUUID().slice(0, 8)}`;

    let postId: string;
    try {
      const authorPage = await nonAdminContext.newPage();
      await authorPage.goto(CONSOLE_COMMUNITY);
      await expect(authorPage.getByRole('heading', { level: 1, name: '我的帖子' })).toBeVisible();
      await authorPage.getByLabel('标题').fill(title);
      await authorPage.getByLabel('正文').fill(`e2e 管理内容正文 ${token}`);
      await authorPage.getByLabel('标签').fill(tag);
      await authorPage.getByRole('button', { name: '发布', exact: true }).click();
      await expect(authorPage).toHaveURL(/\/community\/[^/]+$/);
      postId = new URL(authorPage.url()).pathname.split('/').at(-1) ?? '';
      if (postId === '') throw new Error(`发帖后无法从 URL 读取帖子 id：${authorPage.url()}`);
      await expect(authorPage.getByRole('heading', { level: 1, name: title })).toBeVisible();
    } finally {
      await nonAdminContext.close();
    }

    const adminContext = await browser.newContext({
      baseURL: BASE_URL,
      storageState: ADMIN_STORAGE,
    });
    try {
      const adminPage = await adminContext.newPage();

      /* 下架：内容管理页按标题定位行，按钮是「下架」。 */
      await adminPage.goto(ADMIN_CONTENT);
      await expect(adminPage.getByRole('heading', { level: 1, name: '内容管理' })).toBeVisible();
      const postRow = viewportRow(adminPage, title);
      await expect(postRow).toBeVisible();
      await expect(postRow).toContainText('正常');
      await postRow.getByRole('button', { name: '下架' }).click();

      await expect(adminPage).toHaveURL(/\/admin\/content/);
      await expect(adminPage.getByRole('status')).toHaveText('帖子已下架，公开侧立即不可见。');
      await expect(viewportRow(adminPage, title)).toContainText('已下架 / 已删除');

      await adminPage.goto('/admin/audit');
      await expect(auditRow(adminPage, '下架帖子', postId)).toBeVisible();

      /* 公开侧立即可见性变化。 */
      const publicPage = await adminContext.newPage();
      await publicPage.goto(communityPostPath(postId));
      await expect(publicPage.getByRole('heading', { name: '内容不可见' })).toBeVisible();

      /* 恢复：同一行现在给的是「恢复」。 */
      await adminPage.goto(ADMIN_CONTENT);
      await viewportRow(adminPage, title).getByRole('button', { name: '恢复' }).click();
      await expect(adminPage.getByRole('status')).toHaveText('帖子已恢复。');
      await expect(viewportRow(adminPage, title)).toContainText('正常');

      await adminPage.goto('/admin/audit');
      await expect(auditRow(adminPage, '恢复帖子', postId)).toBeVisible();

      await publicPage.goto(communityPostPath(postId));
      await expect(publicPage.getByRole('heading', { level: 1, name: title })).toBeVisible();
    } finally {
      await adminContext.close();
    }
  });
});

test.describe('站点配置', () => {
  test('三项配额按三态语义保存并回显，动作留审计', async ({ page }) => {
    await page.goto(ADMIN_CONFIG);
    await expect(page.getByRole('heading', { level: 1, name: '站点配置' })).toBeVisible();

    /* 三个输入都有确定终值：发帖 = MAX（正整数覆盖）、评论 = 0（关闭）、工具 = 空（不覆盖）。 */
    await page.getByLabel('发帖配额（条 / 小时）').fill(String(SITE_CONFIG_QUOTA_MAX));
    await page.getByLabel('评论配额（条 / 小时）').fill('0');
    await page.getByLabel('工具运行配额（次 / 小时）').fill('');
    await page.getByRole('button', { name: '保存配置' }).click();

    await expect(page).toHaveURL(/\/admin\/config/);
    await expect(page.getByRole('status')).toHaveText('站点配置已保存，新的配额立即生效。');
    await expect(page.getByLabel('发帖配额（条 / 小时）')).toHaveValue(
      String(SITE_CONFIG_QUOTA_MAX),
    );
    await expect(page.getByLabel('评论配额（条 / 小时）')).toHaveValue('0');
    await expect(page.getByLabel('工具运行配额（次 / 小时）')).toHaveValue('');
    await expect(page.getByText('最后改动：')).toBeVisible();

    /* 0 = 关闭是全局开关，留着会打挂并发跑的社区回归——立即存一次全空恢复默认语义。 */
    await page.getByLabel('发帖配额（条 / 小时）').fill('');
    await page.getByLabel('评论配额（条 / 小时）').fill('');
    await page.getByLabel('工具运行配额（次 / 小时）').fill('');
    await page.getByRole('button', { name: '保存配置' }).click();

    await expect(page).toHaveURL(/\/admin\/config/);
    await expect(page.getByRole('status')).toHaveText('站点配置已保存，新的配额立即生效。');
    await expect(page.getByLabel('发帖配额（条 / 小时）')).toHaveValue('');
    await expect(page.getByLabel('评论配额（条 / 小时）')).toHaveValue('');
    await expect(page.getByLabel('工具运行配额（次 / 小时）')).toHaveValue('');

    /* 每次保存都落一条审计；两个 project 并发各写一条，取最新一行断言。 */
    await page.goto('/admin/audit');
    const row = viewportRow(page, 'site.config.update').filter({ hasText: '更新站点配置' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('站点配置');
  });
});

test.describe('任务管理', () => {
  test('只读统计页照常渲染', async ({ page }) => {
    await page.goto(ADMIN_TASKS);
    await expect(page.getByRole('heading', { level: 1, name: '任务管理' })).toBeVisible();
    await expect(page.getByText('总运行次数')).toBeVisible();
    await expect(page.getByText('按工具聚合')).toBeVisible();
    await expect(page.getByText('最近运行')).toBeVisible();
    await expect(page.getByText(/\d+ 条运行明细/)).toBeVisible();
  });
});
