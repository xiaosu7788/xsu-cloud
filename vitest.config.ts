import { defineConfig } from 'vitest/config';

/**
 * 根测试配置。测试与被测代码同包放置，路径约定为 <包>/tests/**\/*.test.ts。
 *
 * 覆盖率门槛（packages/core 分支覆盖 ≥80%）在 M2 随第一行业务代码一起启用，
 * 见 docs/ROADMAP.md 与 AGENTS.md 第 7 节。现在开启只会得到一个空洞的 100%。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
  },
});
