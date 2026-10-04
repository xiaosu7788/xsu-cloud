/**
 * 管理员登录夹具（Playwright 的 `setup` project）。
 *
 * 先准备真实的 admin 账号，再通过登录页获得 Better Auth 真 cookie，供社区举报 e2e
 * 在同一个测试过程中切换到管理员视角。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup, expect } from '@playwright/test';

import { CONSOLE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';

import { ADMIN, ADMIN_STORAGE } from './env';
import { seedAdmin } from './admin-seed';

setup('造出管理员账号并登录一次，保存会话状态', async ({ page }) => {
  await seedAdmin();

  await page.goto(SIGN_IN_PATH);
  await expect(page.getByRole('button', { name: '跟随系统' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByLabel('邮箱').fill(ADMIN.email);
  await page.getByLabel('密码').fill(ADMIN.password);
  await expect(page.getByLabel('邮箱')).toHaveValue(ADMIN.email);
  await expect(page.getByLabel('密码')).toHaveValue(ADMIN.password);

  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${CONSOLE_HOME}$`), { timeout: 15_000 });

  mkdirSync(dirname(ADMIN_STORAGE), { recursive: true });
  await page.context().storageState({ path: ADMIN_STORAGE });
});
