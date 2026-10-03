/**
 * 工具箱夹具（Playwright 的 `setup` project，与 `auth.setup.ts` 并列）。
 *
 * 它做一件事：造出一条**属于他人账号**的运行记录，把坐标落盘到 `FOREIGN_TOOL_RUN_FILE`。
 *
 * ## 为什么落盘而不是在用例里现造
 *
 * desktop / mobile 两个 project 会并发跑同一份用例（`playwright.config.ts` 的
 * `fullyParallel: true`），而 `seedForeignToolRun()` 是「先删后建」的幂等夹具：两边各跑
 * 一次时，一边刚造出来的记录会被另一边删掉。用例于是会以「这条 id 不存在」的方式通过——
 * 断言是绿的，验的事情却不是「别人的记录打不开」。放进 setup project 只跑一次，
 * 两个 project 读同一份坐标就不存在这个窗口。
 *
 * ## 为什么 setup project 里放得下两个文件
 *
 * `playwright.config.ts` 的 `setup` project 用 `testMatch: /\.setup\.ts$/` 匹配本文件与
 * `auth.setup.ts`。两者动的是不同账号（`seedNonAdmin()` 反复重建普通用户、
 * `seedForeignToolRun()` 反复重建他人账号），互不干扰，可以并发跑。
 *
 * ## 不落盘会话状态
 *
 * 他人账号**从不登录**，所以这里只写坐标、不写 storageState。真正要用他人身份的断言
 * （匿名视角、以及「自己的列表里没有别人的记录」）都不需要登录成他人。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup } from '@playwright/test';

import { FOREIGN_TOOL_RUN_FILE } from './env';
import { seedForeignToolRun } from './tools-seed';

setup('造出一条属于他人账号的运行记录，落盘坐标', async () => {
  const foreign = await seedForeignToolRun();

  mkdirSync(dirname(FOREIGN_TOOL_RUN_FILE), { recursive: true });
  /* 带缩进与结尾换行：这份文件是排查现场时人会直接打开看的东西。 */
  writeFileSync(FOREIGN_TOOL_RUN_FILE, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');
});
