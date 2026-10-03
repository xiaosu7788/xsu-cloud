/**
 * 工具箱模块的入口。`packages/core/src/index.ts` 只转发本文件，
 * 文件多了也不用改根入口。
 *
 * 依赖方向：`builtin.ts` 定义工具实例 → `registry.ts` 建索引 → `run-tool.ts` 用索引跑执行规则。
 * 不允许反向（`builtin.ts` 不得 import `registry.ts`）。
 */
export * from './builtin';
export * from './registry';
export * from './run-tool';
export * from './types';
