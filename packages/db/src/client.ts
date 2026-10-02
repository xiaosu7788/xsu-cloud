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
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

const DEFAULT_POOL_MAX = 10;

function readDatabaseUrl(): string {
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
