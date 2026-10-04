/**
 * 退出标准 3：非管理员访问 `(admin)` 得到统一拒绝响应。
 *
 * `docs/PRD.md` 3.5 验收 2 把它写成「不能一处 403 一处 404 一处 500」，`docs/ROADMAP.md` M1
 * 退出标准 3 是同一件事。这条用例分两半：
 *
 * - **未登录**：全部受保护路由一律 `307 → /sign-in`，而且每一条的状态码与 `Location` 完全相同
 *   ——「统一」在这里是可断言的：不同的响应形状是缺陷，哪怕每个单看都说得通；
 * - **已登录但不是管理员**：`(admin)` 渲染 `AccessDenied`，正文里的状态码与错误码取自
 *   `@xsu/core` 的 `ACCESS_DENIED`（不是抄一份文案），而同一个账号访问 `(console)` 与首页正常。
 *
 * 判「统一」用的是响应形状与「到底是不是拒绝页」，不是状态码：已登录那条分支的 HTTP 状态是
 * 200 而不是 403，理由见 `features/auth/guard.ts` 文件头（Next 的真 403 挂在实验特性下）。
 *
 * 已登录的那一半用 `setup` project 落盘的真实会话（见 `./auth.setup.ts`）：账号由
 * `e2e/seed.ts` 走真实注册编排造出来，角色是数据库里的 `user`。
 */
import { expect, test } from '@playwright/test';
import { ACCESS_DENIED } from '@xsu/core';

import { ADMIN_REPORTS } from '@/features/community/routes';

import {
  ADMIN_AUDIT,
  ADMIN_CONFIG,
  ADMIN_CONTENT,
  ADMIN_TASKS,
  ADMIN_USERS,
} from '@/features/admin/routes';
import {
  ADMIN_HOME,
  CONSOLE_HOME,
  CONSOLE_SETTINGS,
  SITE_HOME,
  SIGN_IN_PATH,
} from '@/features/auth/routes';

import { NON_ADMIN_STORAGE } from './env';

/**
 * 受保护分区的门牌号。匿名访问每一个都必须得到同一种响应。
 * 往 `(console)` / `(admin)` 里加页面时，把它们补进来。
 */
const GUARDED_PATHS = [
  CONSOLE_HOME,
  CONSOLE_SETTINGS,
  ADMIN_HOME,
  ADMIN_USERS,
  ADMIN_CONTENT,
  ADMIN_TASKS,
  ADMIN_CONFIG,
  ADMIN_AUDIT,
  ADMIN_REPORTS,
] as const;

/**
 * `(admin)` 分区当前的页面。数组会按页面逐条断言统一拒绝视图。
 */
const ADMIN_PATHS = [
  ADMIN_HOME,
  ADMIN_USERS,
  ADMIN_CONTENT,
  ADMIN_TASKS,
  ADMIN_CONFIG,
  ADMIN_AUDIT,
  ADMIN_REPORTS,
] as const;

/** 拒绝视图上的对账信息：状态码与错误码都来自领域层那张表。 */
const DENIAL_MARKER = `${ACCESS_DENIED.forbidden.status} ${ACCESS_DENIED.forbidden.code}`;

test.describe('匿名访问受保护路由', () => {
  for (const path of GUARDED_PATHS) {
    test(`${path} 重定向到登录页`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), `${path} 没有把匿名请求弹到登录页。`).toBe(307);
      expect(new URL(response.headers()['location'] ?? '', 'http://127.0.0.1').pathname).toBe(
        SIGN_IN_PATH,
      );
    });
  }

  test('所有受保护路由收到的是同一种响应', async ({ request }) => {
    const observed: { path: string; status: number; location: string | undefined }[] = [];

    for (const path of GUARDED_PATHS) {
      const response = await request.get(path, { maxRedirects: 0 });
      observed.push({ path, status: response.status(), location: response.headers()['location'] });
    }

    const summary = observed
      .map((item) => `${item.path} → ${item.status} ${item.location ?? '(无 Location)'}`)
      .join('，');
    const statuses = new Set(observed.map((item) => item.status));
    const locations = new Set(observed.map((item) => item.location));

    expect(statuses.size, `受保护路由的状态码不一致，实际：${summary}`).toBe(1);
    expect(locations.size, `受保护路由的重定向目标不一致，实际：${summary}`).toBe(1);
    /* 混进 403/404/500 正是这条验收标准点名要防的事。 */
    expect([...statuses], `匿名拒绝响应不是重定向，实际：${summary}`).toEqual([307]);
  });
});

test.describe('已登录的非管理员', () => {
  test.use({ storageState: NON_ADMIN_STORAGE });

  for (const path of ADMIN_PATHS) {
    test(`${path} 渲染统一拒绝视图`, async ({ page }) => {
      const response = await page.goto(path);

      /* 200 是一处实现选择（见文件头）；在这里出现 404 或 500 就是缺陷。 */
      expect(response?.status(), `${path} 的状态码不是拒绝页该有的 200。`).toBe(200);

      await expect(page.getByText('无法访问', { exact: true })).toBeVisible();
      await expect(page.getByText(ACCESS_DENIED.forbidden.message, { exact: true })).toBeVisible();
      await expect(page.getByText(DENIAL_MARKER)).toBeVisible();

      /* 拒绝页不能是死路：两个出口都得在，而且都得指向真的存在的页面。 */
      await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible();
      await expect(page.getByRole('link', { name: '我的控制台' })).toBeVisible();
    });
  }

  test('同一账号访问控制台与首页都不被拒绝', async ({ page }) => {
    await page.goto(CONSOLE_HOME);
    await expect(page.getByRole('heading', { level: 1, name: '控制台' })).toBeVisible();
    await expect(
      page.getByText('无法访问', { exact: true }),
      '控制台对任何合法角色都开放，这里不该出现拒绝页。',
    ).toBeHidden();

    await page.goto(SITE_HOME);
    await expect(page.getByRole('heading', { level: 1, name: 'xsu-cloud' })).toBeVisible();
  });
});
