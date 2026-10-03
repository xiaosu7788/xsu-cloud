/**
 * 登录夹具（Playwright 的 `setup` project）。
 *
 * 它做两件事，顺序不能反：
 *
 * 1. `seedNonAdmin()` 走真实注册编排造出一个「邮箱已验证、角色 `user`」的账号（见 `./seed`）；
 * 2. 通过**登录页界面**真的登录一次，把会话状态落盘。
 *
 * ## 为什么要在界面上登录，而不是直接把会话 cookie 写进 storageState
 *
 * 自己拼一个 cookie 就等于手写一份「Better Auth 的会话 cookie 长什么样」的副本——库改了
 * cookie 名、签名方式或前缀，这里不会报错，只会得到一堆「偶发 401」的用例。走一次真实登录，
 * storageState 里装的就是服务端真实发出的东西。代价是这一步依赖登录表单的可用性，
 * 但「登录表单能用」本身也是 M1 要保住的东西：它坏了，这个 project 先红。
 *
 * ## 落盘位置
 *
 * `Temp/out/playwright/auth/non-admin.json`（见 `./env` 的 `NON_ADMIN_STORAGE`）。里面有真实
 * 会话 cookie，所以它必须待在被 `.gitignore` 忽略的 `Temp/` 下，不能放进 `apps/web/e2e/`。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup, expect } from '@playwright/test';

import { CONSOLE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';

import { NON_ADMIN, NON_ADMIN_STORAGE } from './env';
import { seedNonAdmin } from './seed';

setup('造出非管理员账号并登录一次，保存会话状态', async ({ page }) => {
  await seedNonAdmin();

  await page.goto(SIGN_IN_PATH);

  /*
   * 先等水合完成，再往输入框里写字。**这两步的顺序不能反。**
   *
   * 反过来的后果实测过：`fill` 在页面还没水合时就写进了 SSR 出来的 DOM，随后 React 水合
   * 接管这两个受控输入框，把它自己的（空）状态刷回 DOM，刚写的字就没了。此时点提交，页面
   * 停在 /sign-in 并只显示表单自己的校验文案「请填写邮箱与密码。」——看起来像表单坏了，
   * 其实是夹具把字写在了一张稍后会被盖掉的纸上。
   *
   * 水合的判据沿用 `public-pages.spec.ts` 用的那一个：`ThemeToggle` 挂载前三个按钮的
   * `aria-pressed` 都是 `"false"`（服务端不知道用户选了什么），挂载后选中项才变成 `"true"`。
   * 全新浏览器上下文里 localStorage 是空的，默认选中「跟随系统」，所以等它变成 `"true"`
   * 就是在等挂载完成。`ThemeToggle` 与表单在同一个 React 根里，它挂上了，表单也就挂上了。
   */
  await expect(page.getByRole('button', { name: '跟随系统' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  /* 按 `Label` 定位而不是按 `id`：改了 `id` 不该让用例失败，改了标签文字才该。 */
  await page.getByLabel('邮箱').fill(NON_ADMIN.email);
  await page.getByLabel('密码').fill(NON_ADMIN.password);

  /*
   * 写完立刻确认它真的在。少了这两行，上面那种失效会以「表单说请填写邮箱与密码」的形式
   * 冒出来——那句话指向的是页面，不是夹具，排查方向会被带偏。
   */
  await expect(page.getByLabel('邮箱')).toHaveValue(NON_ADMIN.email);
  await expect(page.getByLabel('密码')).toHaveValue(NON_ADMIN.password);

  /*
   * `exact: true` 不能省。登录页所在的 `(site)` 外壳顶栏里还有一个名字是「登录」的入口
   * （`SessionBadge`），子串匹配会让 Playwright 的严格模式报「匹配到多个元素」。
   * 那个入口渲染出来是 `<a>`（链接角色），所以这里用 `button` 也能分开，但两个字面量
   * 文案的判据不值得靠角色隐式区分，写明更稳。
   */
  /*
   * 提交只点一次，不套重试。
   *
   * 重试会把「点完之后页面处于什么状态」这件事藏起来：本仓库第一版就写了重试，于是
   * 「表单被整页重载抹空、随后点在空表单上」被读成了「登录偶发失败」，白花了一轮排查。
   * 判据只有一个：「落到控制台」。失败时错误快照里能看到当时的表单值，够定位。
   */
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${CONSOLE_HOME}$`), { timeout: 15_000 });

  mkdirSync(dirname(NON_ADMIN_STORAGE), { recursive: true });
  await page.context().storageState({ path: NON_ADMIN_STORAGE });
});
