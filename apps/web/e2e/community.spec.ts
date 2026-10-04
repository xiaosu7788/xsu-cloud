/**
 * M3 社区端到端回归：真实库、真实会话、桌面与 360px 移动视口。
 *
 * 领域单测锁住纯规则；这里锁住的是页面、Server Action、Route Handler、数据库与管理员
 * 会话连起来之后的可观察行为。每条用例使用随机标题与标签，两个视口并发执行也不会互相
 * 命中同一条帖子或同一条未处理举报。
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import {
  COMMUNITY_HOME,
  COMMUNITY_SEARCH,
  CONSOLE_COMMUNITY,
  communityTagPath,
} from '@/features/community/routes';

import { ADMIN_STORAGE, BASE_URL, NON_ADMIN_STORAGE } from './env';

test.use({ storageState: NON_ADMIN_STORAGE });

type PostFixture = {
  title: string;
  body: string;
  tag: string;
  path: string;
  id: string;
};

function createFixture(testName: string): Omit<PostFixture, 'path' | 'id'> {
  const token = `${testName}-${randomUUID().slice(0, 8)}`.toLowerCase();
  return {
    title: `e2e 社区帖子 ${token}`,
    body: `e2e 社区正文 ${token}`,
    tag: `e2e-${randomUUID().slice(0, 8)}`,
  };
}

async function createPost(
  page: Page,
  fixture: Omit<PostFixture, 'path' | 'id'>,
): Promise<PostFixture> {
  await page.goto(CONSOLE_COMMUNITY);
  await expect(page.getByRole('heading', { level: 1, name: '我的帖子' })).toBeVisible();

  await page.getByLabel('标题').fill(fixture.title);
  await page.getByLabel('正文').fill(fixture.body);
  await page.getByLabel('标签').fill(fixture.tag);
  await page.getByRole('button', { name: '发布', exact: true }).click();

  await expect(page).toHaveURL(/\/community\/[^/]+$/);
  const path = new URL(page.url()).pathname;
  const id = path.split('/').at(-1);
  if (!id) throw new Error(`发帖后无法从 URL 读取帖子 id：${page.url()}`);

  await expect(page.getByRole('heading', { level: 1, name: fixture.title })).toBeVisible();
  await expect(page.getByText(fixture.body, { exact: true })).toBeVisible();

  return { ...fixture, path, id };
}

function postRow(page: Page, title: string) {
  return page.locator('li').filter({ hasText: title }).first();
}

test('发帖、评论、并发点赞与作者软删除贯通公开读写路径', async ({ page }, testInfo) => {
  const fixture = await createPost(page, createFixture(testInfo.project.name));

  await page.goto(communityTagPath(fixture.tag));
  await expect(page.getByRole('heading', { name: `标签：${fixture.tag}` })).toBeVisible();
  await expect(page.getByRole('link', { name: fixture.title, exact: true })).toBeVisible();

  await page.goto(fixture.path);
  await page.getByLabel('写下你的评论').fill(`评论 ${fixture.tag}`);
  await page.getByRole('button', { name: '发表评论', exact: true }).click();
  await expect(page.getByText(`评论 ${fixture.tag}`, { exact: true })).toBeVisible();

  const likeResult = await page.evaluate(
    async ({ id }) => {
      const likeUrl = `/api/community/posts/${id}/like`;
      const responses = await Promise.all([
        fetch(likeUrl, { method: 'POST' }),
        fetch(likeUrl, { method: 'POST' }),
      ]);
      const batch = await fetch(`/api/community/posts/likes?ids=${encodeURIComponent(id)}`);
      const data = (await batch.json()) as { counts?: Record<string, number> };
      return {
        statuses: responses.map((response) => response.status),
        count: data.counts?.[id] ?? null,
      };
    },
    { id: fixture.id },
  );
  expect(likeResult.statuses).toEqual([200, 200]);
  expect(likeResult.count).toBe(1);

  await page.reload();
  await expect(page.getByRole('button', { name: '取消点赞' })).toContainText('1');

  await page.goto(`${COMMUNITY_SEARCH}?q=${encodeURIComponent(fixture.title)}`);
  await expect(page.getByRole('link', { name: fixture.title, exact: true })).toBeVisible();

  await page.goto(CONSOLE_COMMUNITY);
  const row = postRow(page, fixture.title);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText(fixture.title, { exact: true })).toHaveCount(0);

  await page.goto(COMMUNITY_HOME);
  await expect(page.getByRole('link', { name: fixture.title, exact: true })).toHaveCount(0);

  await page.goto(`${COMMUNITY_SEARCH}?q=${encodeURIComponent(fixture.title)}`);
  await expect(page.getByText('没有找到相关帖子。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: fixture.title, exact: true })).toHaveCount(0);

  await page.goto(fixture.path);
  await expect(page.getByRole('heading', { name: '内容不可见' })).toBeVisible();
});

test('举报保持内容可见，管理员确认后才下架并留下审计日志', async ({ page, browser }, testInfo) => {
  const fixture = await createPost(page, createFixture(`${testInfo.project.name}-report`));
  const reason = `e2e 举报理由 ${fixture.tag}`;

  await page.getByRole('button', { name: '举报', exact: true }).click();
  await page.getByLabel('举报理由').fill(reason);
  const reportResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/community/reports' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: '提交举报', exact: true }).click();
  await expect((await reportResponse).status()).toBe(201);
  await expect(page.getByRole('status')).toHaveText('举报已提交，感谢你的反馈。');
  await expect(page.getByRole('heading', { level: 1, name: fixture.title })).toBeVisible();

  const adminContext = await browser.newContext({
    baseURL: BASE_URL,
    storageState: ADMIN_STORAGE,
  });
  try {
    const adminPage = await adminContext.newPage();
    await adminPage.goto('/admin/reports');
    await expect(adminPage.getByRole('heading', { level: 1, name: '举报处理' })).toBeVisible();

    const reportRow = adminPage.locator('li').filter({ hasText: reason }).first();
    await expect(reportRow).toBeVisible();
    await reportRow.getByRole('button', { name: '确认下架', exact: true }).click();

    await expect(adminPage).toHaveURL(/\/admin\/reports$/);
    await expect(adminPage.locator('li').filter({ hasText: reason })).toHaveCount(0);
    const auditRow = adminPage.locator('li').filter({ hasText: fixture.id }).first();
    await expect(auditRow).toContainText('确认下架');
  } finally {
    await adminContext.close();
  }

  await page.goto(fixture.path);
  await expect(page.getByRole('heading', { name: '内容不可见' })).toBeVisible();
  await page.goto(`${COMMUNITY_SEARCH}?q=${encodeURIComponent(fixture.title)}`);
  await expect(page.getByText('没有找到相关帖子。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: fixture.title, exact: true })).toHaveCount(0);
});
