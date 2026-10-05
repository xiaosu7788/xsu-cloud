/**
 * 公开页：渲染、双视口导航壳、360px 无横向滚动、移动端触控目标、axe、主题持久化。
 *
 * 对应 `docs/ROADMAP.md` M1 退出标准 1（静态化由 `static-render.spec.ts` 单独验）与退出标准 2
 * （桌面与移动两套视口下导航均可用、360px 无横向滚动），外加 `docs/PRD.md` 4.1 的
 * 「触控目标 ≥44px」「hover 不得作为唯一反馈」与 4.2 的双主题要求。
 *
 * ## 为什么这些断言分散在 desktop / mobile 两个 project 里都跑
 *
 * 用例本身不区分视口，判据由 `isMobile` 决定分支。共用一份代码是有意的：如果为两套视口各写
 * 一份用例，改了一边漏了另一边只会表现为「某个视口下没人测」——那正是退出标准 2 要防的事。
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { THEME_STORAGE_KEY } from '@/components/theme';
import { SITE_HOME, SIGN_IN_PATH } from '@/features/auth/routes';

import { TOUCH_TARGET_MIN } from './env';

/** 公开分区里当前存在的两页。多一个都要先有页面才写进来（见 `features/auth/routes.ts` 文件头）。 */
const PUBLIC_PATHS = [SITE_HOME, SIGN_IN_PATH] as const;

test('首页渲染出标题与三个能力入口', async ({ page }) => {
  await page.goto(SITE_HOME);

  /*
   * 入口限定在 `main` 里找。
   *
   * 未登录时顶栏（`banner`）里还有一个同名的「登录」入口（`SessionBadge`），直接
   * `page.getByRole('link', { name: '登录' })` 会匹配到两个元素，Playwright 的严格模式
   * 会直接报错而不是挑一个。这里要验的是首页正文有没有把入口渲染出来，所以判据
   * 从 `main` 出发；顶栏那一个是 `SessionBadge` 的事，不属于这条用例。
   *
   * 落地页改版后正文入口从「登录 / 我的控制台 / 工具箱」三个按钮换成 hero 的一对 CTA
   * 加三张能力卡片。断言跟着换成新入口——但**每一条都指向真的存在的页面**，
   * 这与首页「只列已发货能力」的约束是同一件事：断言里出现的路径必须有页面。
   */
  const main = page.getByRole('main');

  await expect(page.getByRole('heading', { level: 1, name: 'xsu-cloud' })).toBeVisible();
  await expect(main.getByRole('link', { name: '登录' })).toBeVisible();
  await expect(main.getByRole('link', { name: '注册' })).toBeVisible();

  /* 三张能力卡片的入口。`进入控制台` 需要登录，但链接本身对匿名用户也渲染。 */
  await expect(main.getByRole('link', { name: '进入控制台' })).toBeVisible();
  await expect(main.getByRole('link', { name: '打开工具箱' })).toBeVisible();
  await expect(main.getByRole('link', { name: '浏览社区' })).toBeVisible();
});

test('公开页顶栏在两套视口下都可用', async ({ page, isMobile }) => {
  await page.goto(SITE_HOME);

  const header = page.locator('header');
  await expect(header.getByRole('link', { name: 'xsu-cloud' })).toBeVisible();
  /* 主题切换在任何视口、任何登录状态下都在（见 `app/(site)/layout.tsx` 的注释）。 */
  await expect(page.getByRole('group', { name: '主题' })).toBeVisible();

  /*
   * 这里**必须**用 CSS 定位器而不是 `getByRole`。
   *
   * `getByRole` 只匹配可访问性树里的元素，`display: none` 的会被直接忽略——于是「窄屏下
   * 顶栏导航应该消失」这条断言会变成「匹配到 0 个元素，于是没有元素可见」，空断言通过。
   * `toHaveCount(1)` 先把「元素在 DOM 里」钉死，可见性断言才有意义。
   */
  const nav = page.locator('header nav[aria-label="站点导航"]');
  await expect(nav).toHaveCount(1);

  if (isMobile) {
    /* 移动端只是把链接收起（`hidden md:block`），品牌与操作区仍在，导航因此「可用」。 */
    await expect(nav).toBeHidden();
  } else {
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: '首页' })).toBeVisible();
  }
});

for (const path of PUBLIC_PATHS) {
  test(`${path} 在当前视口下没有横向滚动`, async ({ page }, testInfo) => {
    await page.goto(path);

    /*
     * 判据是根滚动元素的 `scrollWidth` 与 `clientWidth` 之差，不是「有没有出现滚动条」——
     * 滚动条是否显示受系统设置影响，而横向溢出量是一个稳定的事实。
     * 移动 project 的视口是 360px，就是 `docs/PRD.md` 4.1 点名的那个宽度。
     */
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement;
      return root ? root.scrollWidth - root.clientWidth : 0;
    });

    expect(overflow, `视口 ${testInfo.project.name} 下 ${path} 横向溢出 ${overflow}px`).toBe(0);
  });
}

test('移动端顶栏的可点项都不小于 44px', async ({ page, isMobile }) => {
  test.skip(!isMobile, '触控目标的承诺只对触控设备成立；桌面按鼠标密度取 36px。');

  await page.goto(SITE_HOME);

  /*
   * `filter({ visible: true })` 而不是 `:visible` 伪类：前者是 Playwright 自己判定的可见性，
   * 与 `display: none` 的窄屏隐藏规则一致。窄屏下顶栏的导航链接正好是隐藏的，不该被算进来。
   */
  const targets = page.locator('header a, header button').filter({ visible: true });

  const count = await targets.count();
  expect(count, '顶栏一个可点项都没有，这条断言就没在验任何东西').toBeGreaterThan(0);

  const measured: { name: string; height: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    const box = await target.boundingBox();
    if (!box) continue;
    const name = (await target.getAttribute('aria-label')) ?? (await target.innerText()).trim();
    measured.push({ name: name || `（第 ${index + 1} 个可点项）`, height: box.height });
  }

  expect(
    measured.filter((item) => item.height < TOUCH_TARGET_MIN),
    `共量了 ${measured.length} 项：${measured.map((item) => `${item.name}=${item.height}px`).join('，')}`,
  ).toEqual([]);
});

for (const path of PUBLIC_PATHS) {
  test(`axe：${path} 无 serious / critical 违规`, async ({ page }) => {
    await page.goto(path);

    const { violations } = await new AxeBuilder({ page }).analyze();

    /*
     * 只把 serious / critical 判为失败。moderate 与 minor 里混着不少「最佳实践」建议，
     * 把它们变成必过项会让这条断言很快被人加 `disableRules` 绕过去——那时它就不再拦任何东西。
     * `AGENTS.md` 第 7 节的 PR 级要求写的也正是「axe 无 serious 问题」。
     */
    const blocking = violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.impact} ${violation.id}：${violation.help}（${violation.nodes.length} 处）`,
      );

    expect(blocking).toEqual([]);
  });
}

test('主题切换会落到 html 上，并在刷新后保持', async ({ page }) => {
  await page.goto(SITE_HOME);

  const systemButton = page.getByRole('button', { name: '跟随系统' });
  const darkButton = page.getByRole('button', { name: '深色' });

  /*
   * 等 `aria-pressed` 出现，就是在等水合完成：`ThemeToggle` 在挂载前不写这个属性
   * （见 `components/theme-toggle.tsx` 的 `mounted`）。不等它就去点，点击可能落在
   * 还没接上事件处理器的按钮上，然后表现为「时不时失败」。
   */
  await expect(systemButton).toHaveAttribute('aria-pressed', 'true');

  await darkButton.click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(darkButton).toHaveAttribute('aria-pressed', 'true');

  /*
   * 回到「跟随系统」。这一条不是顺手多写的：`components/theme.ts` 用三选一而不是开关，
   * 唯一理由就是让这个状态可达。如果「点过深色之后就回不去系统」，这里会红。
   */
  await systemButton.click();
  await expect(systemButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY);
  expect(stored).toBe('system');
});
