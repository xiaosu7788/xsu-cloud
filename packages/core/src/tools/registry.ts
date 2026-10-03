/**
 * 工具注册表：slug → 工具定义。**这是「有哪些工具」的唯一来源。**
 *
 * 目录放在代码里而不是建 `tools` 表，理由见 `docs/spec/SPEC-tools.md` 第 2 节。
 * 由此派生的两条纪律：
 *
 * 1. 任何要用 slug 的地方（执行、收藏、历史详情）**必须先过这里**。`tool_runs.tool_slug`
 *    没有外键，写进去之前不校验就等于让数据库接受任意字符串。
 * 2. slug 一旦发布就不再改名——运行历史与收藏都按它存，改名等于换工具。
 */
import { BUILTIN_TOOLS } from './builtin';
import type { ToolDefinition } from './types';

/**
 * slug 索引。用 Map 而不是每次 `find`：执行路径上每次请求都要查一次，
 * 而这张表的内容在编译期就定死了，没有理由线性扫描。
 */
const REGISTRY: ReadonlyMap<string, ToolDefinition> = buildRegistry(BUILTIN_TOOLS);

/**
 * 建索引，并**在模块加载时**拦下重复 slug。
 *
 * 放在这里而不是写进单测：重复 slug 会让「谁被覆盖了」完全取决于数组顺序，
 * 是那种只在某个工具被访问时才暴露、且看起来像「工具行为变了」的故障。
 * 加载即抛错，第一次有人 import 本模块时就会看到。
 */
function buildRegistry(tools: readonly ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    if (registry.has(tool.slug)) {
      throw new Error(`工具注册表里有重复的 slug：${tool.slug}`);
    }
    registry.set(tool.slug, tool);
  }

  return registry;
}

/** 按 slug 取工具；不在注册表里返回 `undefined`（调用方负责翻译成 `toolNotFound`）。 */
export function findTool(slug: string): ToolDefinition | undefined {
  return REGISTRY.get(slug);
}

/**
 * 清单页用的全部工具。
 *
 * 返回注册顺序（即 `builtin.ts` 里的书写顺序），**调用方不要再排序**：
 * 展示顺序是产品的决定，分散到各个页面排序就会出现两种顺序。
 */
export function listTools(): readonly ToolDefinition[] {
  return BUILTIN_TOOLS;
}

/**
 * slug 是否还在注册表里。
 *
 * 收藏表里可能留着已下架工具的 slug（`tool_slug` 无外键），页面据此把它们过滤掉，
 * 而不是渲染一个点了会 404 的入口。
 */
export function isRegisteredToolSlug(slug: string): boolean {
  return REGISTRY.has(slug);
}
