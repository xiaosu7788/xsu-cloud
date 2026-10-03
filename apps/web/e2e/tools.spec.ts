/**
 * 工具箱（M2）的端到端验收。
 *
 * 对账关系（`docs/PRD.md` 3.3 的四条验收 + `docs/ROADMAP.md` M2 退出标准 2）：
 *
 * | 用例 | 钉住的事实 |
 * | --- | --- |
 * | 未登录时执行页与单条记录都重定向 | 带参数的页面也走同一个守卫，没有一条旁路 |
 * | 公开清单页列出全部工具、不含执行入口 | `listTools()` 是唯一来源；公开页不引导人去撞登录墙 |
 * | 工具台列出全部工具与配额说明 | 清单来自代码，收藏来自库 |
 * | 执行 → 本页出结果 → 运行记录里那一条 | 「有结果必有记录」（先落历史再返回） |
 * | 坏输入 → 结构化错误 + 一行失败历史 | 验收 1：不吞异常、不伪成功 |
 * | 敏感工具的历史里没有原文 | 验收 2：运行历史不是口令仓库 |
 * | 别人的记录打不开，且与不存在的 id 同一个视图 | 验收 4；两种视图一旦不同就是存在性探针 |
 * | 自己的列表里不出现别人的记录 | 验收 4 的另一半 |
 * | 收藏与取消收藏立刻反映在工具台上 | M2 交付物里的「收藏」 |
 *
 * ## 他人记录为什么由 `setup` project 落盘
 *
 * 那条记录必须真在库里躺着，否则「别人的记录打不开」验的会是「这个 id 不存在」。造它的
 * `seedForeignToolRun()` 是「先删后建」的幂等夹具，不能在用例里现造（理由见
 * `./tools.setup.ts` 文件头）。
 *
 * ## desktop 与 mobile 并发跑同一份用例，而且共用同一个账号
 *
 * `playwright.config.ts` 的 `fullyParallel: true` 让两个 project 同时跑本文件，两边读的是
 * 同一份 `NON_ADMIN_STORAGE`。只读断言不受影响，执行工具也安全（每次新建一行，谁也不读
 * 谁）；但会**改写同一份状态**的收藏开关必须只在一个 project 里跑（`onlyOncePerRun`），
 * 否则两边互相把对方的收藏取消掉。
 *
 * ## 表格页的两种形态同时在 DOM 里
 *
 * `ResponsiveTable` 的表格（`hidden md:block`）与卡片（`md:hidden`）一份数据渲染两遍，
 * 所以同一个值在页面上出现两次。`getByText` 不判断可见性，直接断言会撞严格模式，而按
 * DOM 顺序取第一个在移动视口下取到的恰好是隐藏的那一份 —— 用 `visible()` 收口。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { listTools, TOOL_FAILURE } from '@xsu/core';

import { SIGN_IN_PATH } from '@/features/auth/routes';
import {
  CONSOLE_TOOLS,
  CONSOLE_TOOLS_RUNS,
  TOOLS_HOME,
  consoleToolPath,
  consoleToolRunPath,
} from '@/features/tools/routes';

import { BASE_URL, FOREIGN_TOOL_RUN_FILE, NON_ADMIN_STORAGE } from './env';
import { FOREIGN_TOOL_SLUG, type ForeignToolRun } from './tools-seed';

/**
 * 用例点名的两个工具。
 *
 * 不写死名字（`JSON 格式化` / `哈希摘要`）而只用 slug 取注册表：展示名是产品决定，改名时
 * 用例不该跟着红。`json-format` 的输出可以逐字符核对，且输入坏掉时落的是「用户能自己修
 * 的错」那一档；`hash` 是 `sensitive: true` 的那一档。
 */
const FORMAT_SLUG = 'json-format';
const SENSITIVE_SLUG = 'hash';

/**
 * 取一个注册表里的工具。取不到就抛：工具被改名或删掉时这里要立刻红，而不是让后面的断言
 * 落在一个 404 页上「静默成立」。
 */
function requireTool(slug: string): { slug: string; name: string } {
  const tool = listTools().find((candidate) => candidate.slug === slug);
  if (!tool) {
    throw new Error(
      `注册表里没有 slug 为 ${slug} 的工具：用例点名的工具被改名或删掉了，请同步本文件。`,
    );
  }
  return tool;
}

/** 只取可见的那一个。理由见文件头「表格页的两种形态同时在 DOM 里」。 */
function visible(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/** 按卡片标题定位一张卡片。`Card` 的 `data-slot` 让这件事不依赖类名。 */
function cardByTitle(page: Page, title: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: title });
}

/** 构建产物/共享状态与视口无关的用例只跑一次，与 `./static-render.spec.ts` 同一个手法。 */
function onlyOncePerRun(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'desktop', '这条用例改写共享状态，只在 desktop 里跑一次。');
}

/** 读 `./tools.setup.ts` 落盘的他人记录坐标。 */
function readForeignRun(): ForeignToolRun {
  try {
    return JSON.parse(readFileSync(FOREIGN_TOOL_RUN_FILE, 'utf8')) as ForeignToolRun;
  } catch (error) {
    throw new Error(
      `读不到他人运行记录的坐标 ${FOREIGN_TOOL_RUN_FILE}：${String(error)}\n` +
        '它由 `e2e/tools.setup.ts` 落盘。从 playwright.config.ts 跑（desktop/mobile 都依赖 setup）' +
        '不会到这里；只有单跑本文件时才需要先跑一次 setup project。',
      { cause: error },
    );
  }
}

/** 「查看运行记录」的 href → 运行记录 id。取不到就抛，别把断言建在一个空值上。 */
function runIdFromHref(href: string | null): string {
  const id = href
    ?.split('/')
    .filter((part) => part.length > 0)
    .pop();
  if (!id) throw new Error(`「查看运行记录」的链接里没有运行记录 id：${String(href)}`);
  return id;
}

test.describe('未登录访问工具箱的带参数页面', () => {
  /*
   * 分区里的每一条地址都自己守一次（`(console)/layout.tsx` 的守卫在分区内部跳转时可能被
   * 路由缓存复用）。这两个地址带参数，落在 `admin-access.spec.ts` 的静态清单之外，
   * 所以在这里点名验。单条记录那条故意用一个不存在也读不到的 id：判定发生在查库之前，
   * 匿名请求连「这个 id 存不存在」都不该问出来。
   */
  test('执行页与单条记录都重定向到登录页', async ({ request }) => {
    const paths = [
      consoleToolPath(requireTool(FORMAT_SLUG).slug),
      consoleToolRunPath(readForeignRun().runId),
    ];

    for (const path of paths) {
      const response = await request.get(path, { maxRedirects: 0 });

      expect(response.status(), `${path} 没有把匿名请求弹到登录页。`).toBe(307);
      const location = new URL(response.headers()['location'] ?? '', BASE_URL).pathname;
      expect(location, `${path} 的重定向目标不是登录页。`).toBe(SIGN_IN_PATH);
    }
  });
});

test.describe('公开的工具清单页', () => {
  test('列出注册表里的全部工具，且不含执行入口', async ({ page }) => {
    const tools = listTools();
    expect(tools.length, '注册表是空的：这条用例会「因为没东西可漏而通过」。').toBeGreaterThan(0);

    await page.goto(TOOLS_HOME);

    await expect(page.getByRole('heading', { level: 1, name: '工具箱' })).toBeVisible();
    /* 数量来自注册表，不是抄在页面上的第二个事实。 */
    await expect(page.getByText(`共 ${tools.length} 个工具`)).toBeVisible();

    for (const tool of tools) {
      await expect(page.getByText(tool.name, { exact: true })).toBeVisible();
      /*
       * 执行要登录，公开页放一个「点进去被弹到登录页」的按钮只会让人以为这里坏了。
       * 因此这里断言的是「没有指向执行页的链接」，而不是「没有按钮」。
       */
      await expect(
        page.locator(`a[href="${consoleToolPath(tool.slug)}"]`),
        `${tool.slug} 的执行入口出现在了公开页上。`,
      ).toHaveCount(0);
    }
  });
});

test.describe('已登录的普通用户', () => {
  test.use({ storageState: NON_ADMIN_STORAGE });

  test('工具台列出全部工具，并写明配额', async ({ page }) => {
    const tools = listTools();

    await page.goto(CONSOLE_TOOLS);
    await expect(page.getByRole('heading', { level: 1, name: '工具箱' })).toBeVisible();

    const allTools = cardByTitle(page, '全部工具');
    await expect(allTools).toBeVisible();

    for (const tool of tools) {
      await expect(allTools.getByText(tool.name, { exact: true })).toBeVisible();
    }
    /* 清单里的每个工具都要有入口，否则「能用但点不进去」。 */
    await expect(allTools.getByRole('link', { name: '打开', exact: true })).toHaveCount(
      tools.length,
    );

    /* 配额上限由配置决定（本机走默认 30），页面上要把这个事实说出来而不是留白。 */
    await expect(page.getByText(/每个账号每小时最多执行 \d+ 次/)).toBeVisible();
  });

  test('执行 JSON 格式化：结果就在本页，随后能在运行历史里打开那一条', async ({ page }) => {
    const tool = requireTool(FORMAT_SLUG);

    await page.goto(consoleToolPath(tool.slug));
    await expect(page.getByRole('heading', { level: 1, name: tool.name })).toBeVisible();

    await page.getByLabel('JSON 文本').fill('{"b":2,"a":[1,2]}');
    await page.getByRole('button', { name: '执行' }).click();

    const result = page.getByRole('region', { name: '执行结果' });
    await expect(result).toBeVisible();
    /* 格式化后的缩进与键顺序都是这个工具的产物，逐段核对而不是只看「有没有输出」。 */
    await expect(result.locator('pre')).toHaveText(/\{\s*"b": 2,\s*"a": \[\s*1,\s*2\s*\]\s*\}/);

    const runLink = result.getByRole('link', { name: '查看运行记录' });
    const runId = runIdFromHref(await runLink.getAttribute('href'));
    await runLink.click();

    /* 「有结果必有记录」：结果里给的入口必须真的能打开本次执行的那一条。 */
    await expect(page).toHaveURL(`${BASE_URL}${consoleToolRunPath(runId)}`);
    await expect(page.getByRole('heading', { level: 1, name: tool.name })).toBeVisible();
    await expect(cardByTitle(page, '概况').getByText(runId)).toBeVisible();
    /*
     * 摘要存的是「字段=值」，不是原始输入；非敏感工具的预览长度上限是 120 字符，
     * 这条输入远短于它，所以能逐字符对上。
     */
    await expect(cardByTitle(page, '输入摘要')).toContainText('text={"b":2,"a":[1,2]}');
    await expect(cardByTitle(page, '输出摘要')).toContainText('"b": 2');

    /*
     * 列表侧也要能看见它：点工具名进详情是这条入口的另一半。
     *
     * 两个 project 共用同一个账号并发跑本文件，各自都会留下成功记录，所以这里能匹配到多行。
     * `.first()` 是有意的：验的是「列表里有这一条」，不是「只有一条」。
     */
    await page.goto(CONSOLE_TOOLS_RUNS);
    await expect(visible(page.getByRole('link', { name: tool.name })).first()).toBeVisible();
    /* caption 在表格与卡片两种形态里各渲染一次（见 `ResponsiveTable`），按可见性收口。 */
    await expect(visible(page.getByText(`按时间倒序，最多显示最近 50 条。`))).toBeVisible();
  });

  test('坏输入返回结构化错误，并留下一行失败历史', async ({ page }) => {
    const tool = requireTool(FORMAT_SLUG);

    await page.goto(consoleToolPath(tool.slug));
    /* 少一个右括号：`JSON.parse` 会抛，属于「用户能自己修的错」（`ToolInputError` → 400）。 */
    await page.getByLabel('JSON 文本').fill('{"a": ');
    await page.getByRole('button', { name: '执行' }).click();

    /*
     * 限定在表单里找这条失败提示：Next 会在页面上另放一个 `role="alert"` 的路由播报器
     * （`#__next-route-announcer__`），不限定范围会连同它一起匹配到（严格模式直接报错）。
     */
    const alert = page.locator('form').getByRole('alert');
    await expect(alert).toBeVisible();
    /*
     * 断言的是**领域层统一的那句话与错误码**，不是 `jsonFormat` 里那句更具体的提示：
     * `executeToolFunction` 会丢掉 `ToolInputError.message`（`packages/core/tests/tools.test.ts`
     * 有同一条断言）。这是有意的——文案只有一份出处，页面上不该出现第二种说法。
     */
    await expect(alert).toContainText(TOOL_FAILURE.inputInvalid.message);
    await expect(alert).toContainText(TOOL_FAILURE.inputInvalid.code);
    /* 指到具体字段，表单才能高亮那一项。 */
    await expect(page.getByLabel('JSON 文本')).toHaveAttribute('aria-invalid', 'true');

    /* 失败也要有记录，否则「用户说失败了但我查不到」无法回答。 */
    await page.goto(CONSOLE_TOOLS_RUNS);
    /* 同前面那条：并发跑的两个 project 各留一行失败记录，这里只验「有这一条」。 */
    await expect(
      visible(page.getByText(TOOL_FAILURE.inputInvalid.message)).first(),
      '失败的执行没有在运行历史里留下记录。',
    ).toBeVisible();
  });

  test('敏感工具的运行历史里没有原文', async ({ page }) => {
    const tool = requireTool(SENSITIVE_SLUG);
    const secret = `xsu-e2e-secret-${randomUUID()}`;

    await page.goto(consoleToolPath(tool.slug));
    /* 敏感提示必须出现在提交之前，而不是事后才说「刚才那次没记」。 */
    await expect(page.getByText(/运行历史只记字段名与长度，不记录内容/)).toBeVisible();

    await page.getByLabel('内容').fill(secret);
    await page.getByLabel('算法').selectOption('sha256');
    await page.getByRole('button', { name: '执行' }).click();

    const result = page.getByRole('region', { name: '执行结果' });
    /* 结果是给用户自己核对用的，必须完整显示（SHA-256 十六进制摘要 64 个字符）。 */
    await expect(result.locator('textarea')).toHaveValue(/^[0-9a-f]{64}$/);

    await result.getByRole('link', { name: '查看运行记录' }).click();
    await expect(page.getByRole('heading', { level: 1, name: tool.name })).toBeVisible();

    /* 输入摘要只有字段名，一个字符的原文都不在。 */
    await expect(cardByTitle(page, '输入摘要')).toContainText('[已脱敏] 字段：text、algorithm');
    /* 输出一个字符都不存，页面上也不该把它渲染成空白（会被读成「记录丢了」）。 */
    await expect(cardByTitle(page, '输出摘要')).toContainText('按设计不记录输出内容');

    /* 两类原文都不许出现在这一页上——含在 URL、标题或任何摘要里都算泄漏。 */
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(page.getByText('[已脱敏] 字段：text、algorithm')).toBeVisible();
  });

  test('别人的运行记录打不开，且与不存在的 id 得到同一个视图', async ({ page }) => {
    const foreign = readForeignRun();

    await page.goto(consoleToolRunPath(foreign.runId));

    const denial = cardByTitle(page, '无法查看');
    await expect(denial).toBeVisible();
    await expect(denial).toContainText(TOOL_FAILURE.runForbidden.message);
    await expect(denial).toContainText(
      `${TOOL_FAILURE.runForbidden.status} ${TOOL_FAILURE.runForbidden.code}`,
    );
    /* 被拒的这一刻连「这条记录里有什么」都不该透露。 */
    await expect(page.getByText(foreign.marker)).toHaveCount(0);
    /* 回退入口指向运行历史，但不带那个 id。 */
    await expect(denial.getByRole('link', { name: '返回运行历史' })).toHaveAttribute(
      'href',
      CONSOLE_TOOLS_RUNS,
    );
    const foreignView = await denial.innerText();

    /* 同一个账号打开一个根本不存在的 id：两种情况的视图必须逐字符相同。 */
    await page.goto(consoleToolRunPath(`e2e-missing-${randomUUID()}`));

    const missing = cardByTitle(page, '无法查看');
    await expect(missing).toBeVisible();
    expect(
      await missing.innerText(),
      '「别人的记录」与「不存在的 id」渲染出了不同的视图：别人能据此判断某个 id 是否存在。',
    ).toBe(foreignView);
  });

  test('自己的运行历史里不出现别人的记录', async ({ page }) => {
    await page.goto(CONSOLE_TOOLS_RUNS);
    await expect(page.getByRole('heading', { level: 1, name: '运行历史' })).toBeVisible();

    /*
     * 夹具那条记录的 slug 故意不在注册表里：`toolDisplayName` 取不到名字时原样返回 slug，
     * 所以它一旦漏进列表，「e2e-retired-tool」这几个字就会出现在页面上。这条断言因此验的是
     * 「列表按人收窄」，而不是「恰好没有这条数据」。
     */
    await expect(
      page.getByText(FOREIGN_TOOL_SLUG),
      '别人的运行记录出现在了当前账号的列表里。',
    ).toHaveCount(0);
  });

  test('收藏与取消收藏立刻反映在工具台上', async ({ page }, testInfo) => {
    onlyOncePerRun(testInfo);

    const tool = requireTool(FORMAT_SLUG);

    await page.goto(CONSOLE_TOOLS);

    const allTools = cardByTitle(page, '全部工具');
    const favoriteButton = allTools
      .locator('li')
      .filter({ hasText: tool.name })
      .getByRole('button', { name: '收藏', exact: true });
    const favoritesCard = cardByTitle(page, '我的收藏');

    /* 前置事实：这个账号由 `e2e/seed.ts` 每轮「先删后建」，收藏随用户一起被级联删掉。 */
    await expect(favoritesCard, '上一轮留下的收藏没被清掉：这条用例的初始状态不可信。').toHaveCount(
      0,
    );

    await favoriteButton.click();

    await expect(favoritesCard).toBeVisible();
    await expect(favoritesCard.getByText(tool.name, { exact: true })).toBeVisible();
    /* 同一个工具在「全部工具」里的按钮要翻转，而不是只在收藏卡片里出现一份副本。 */
    await expect(allTools.getByRole('button', { name: '取消收藏', exact: true })).toHaveCount(1);

    await favoritesCard.getByRole('button', { name: '取消收藏', exact: true }).click();

    await expect(favoritesCard).toHaveCount(0);
    await expect(allTools.getByRole('button', { name: '收藏', exact: true })).toHaveCount(
      listTools().length,
    );

    /* 收尾：把状态还原成这条用例开始时那样，免得后续用例读到一份意外的收藏清单。 */
  });
});
