/**
 * drizzle-kit 配置（只给生成/执行迁移用）。
 *
 * 迁移产物提交进仓库：`packages/db/migrations`。理由见 `docs/DEPLOYMENT.md`——
 * 生产不跑 `push`，只跑已提交的迁移，保证每次上线变更可审计、可回滚。
 */
import { loadEnvFile } from 'node:process';

import { defineConfig } from 'drizzle-kit';

// 本地开发把变量集中放在仓库根的 .env（唯一一份，见 README）。用 Node 自带的读取，
// 不引入 dotenv。文件不存在时直接跳过，交给当前进程的环境变量。
try {
  loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // 没有 .env 就走外部环境变量。
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('缺少环境变量 DATABASE_URL：见 README「本地开发」。');
  }
  return url;
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: requireDatabaseUrl() },
  strict: true,
  verbose: true,
});
