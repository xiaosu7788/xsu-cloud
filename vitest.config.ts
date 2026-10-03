import { defineConfig } from 'vitest/config';

/**
 * 根测试配置。测试与被测代码同包放置，路径约定为 <包>/tests/**\/*.test.ts。
 *
 * 覆盖率门槛只对 `packages/core` 生效，且只卡**分支**（≥80%）：
 * `docs/ROADMAP.md` M2 的退出标准写的就是这一条，`AGENTS.md` 第 7 节与它一致。
 * 其余包不设门槛——数据层与平台层的判定逻辑都落在 `packages/core` 的测试里，
 * `apps/web` 的覆盖靠端到端（Playwright），用行覆盖率去卡它只会得到好看的数字。
 *
 * 门槛一旦启用就不再下调：不够就补测试，必要时说明哪一档是有意留白的
 * （现有的例子是 `runTool` 走不到 `runFailed`，见 `packages/core/tests/tools.test.ts` 的文件头）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      reporter: ['text'],
      thresholds: { branches: 80 },
    },
  },
});
