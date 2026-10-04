/**
 * 数据库连接。
 *
 * 只在这里读 `DATABASE_URL`，其它包一律通过 `@xsu/db` 拿连接，避免连接串散落各处。
 * 连接池参数是保守值：单机部署，先够用；真实容量数字在 M2 的 k6 压测里回填
 * `docs/ARCHITECTURE.md` 第 8 节。
 *
 * `max: 10` 的理由：Postgres 默认 max_connections 是 100，本项目单机单进程，
 * 留出余量给迁移脚本与手工排查，不要占满。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

const DEFAULT_POOL_MAX = 10;

/*
 * 数据层自举加载仓库根的 `.env`。
 *
 * **为什么要在这里做**：`next build` 预渲染公开页时，`generateStaticParams` 会先于任何
 * `getServerEnv()` 调用触发 `getDb()`（M3 e2e 首跑实测：预渲染 `/community` 直接抛
 * 「缺少环境变量 DATABASE_URL」）。分层红线禁止 `@xsu/db` 反向依赖 `@xsu/platform`，
 * 所以不能复用 platform 的同名加载逻辑，只能同语义自实现：从 cwd 向上找
 * `pnpm-workspace.yaml` 定位仓库根，加载其 `.env`。
 *
 * 关键语义与 platform 版一致：`process.loadEnvFile` **不覆盖已存在的环境变量**——CI 在
 * job 级注入的变量（`ci.yml` 的 e2e job）永远赢过文件里的值，真实环境优先。没有 `.env`
 * 可加载时（CI 正是如此）静默跳过，交由 `readDatabaseUrl` 报出原本的错误。
 */
let dotEnvLoaded = false;

function ensureDotEnvLoaded(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = join(dir, '..');
    if (parent === dir) return; // 已到文件系统根：没有 workspace 标记，按未配置处理
    dir = parent;
  }

  const envFile = join(dir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function readDatabaseUrl(): string {
  ensureDotEnvLoaded();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('缺少环境变量 DATABASE_URL：数据库连接串未配置（见 README「本地开发」）。');
  }
  return url;
}

/**
 * 建连接。`max` 为 1 时给迁移脚本与一次性任务用，避免连接数抖动。
 */
export function createDbClient(options: { max?: number } = {}) {
  const client = postgres(readDatabaseUrl(), {
    max: options.max ?? DEFAULT_POOL_MAX,
    onnotice: () => {},
  });

  return { client, db: drizzle(client, { schema }) };
}

/** 应用侧的共享连接。延迟建立，避免 import 阶段就要求环境变量存在。 */
let shared: ReturnType<typeof createDbClient> | undefined;

export function getDb() {
  shared ??= createDbClient();
  return shared.db;
}

export type Database = ReturnType<typeof getDb>;

export { schema };
