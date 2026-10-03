/**
 * 手工入队端：把一条邮件任务与一条清理任务塞进 Redis 队列。
 *
 * 这是 [`docs/TESTING.md`](../docs/TESTING.md) 第 5 节「队列与清理任务的手工回归」的生产者半边：
 * 队列的自动化测试只覆盖 `dispatchJob` 的分派逻辑（提交级不起 Redis），
 * 「任务确实被 worker 取走并处理了」必须有真实 Redis 和真实的消费者进程才验得了。
 *
 * 用法（两个终端）：
 *   1) pnpm --filter @xsu/web worker        # 消费者；日志可重定向到 Temp/out/ 下的文件
 *   2) pnpm exec tsx scripts/enqueue-manual-jobs.ts
 *
 * 两条任务的载荷都是**虚构数据**（收件人 `someone@example.com`、链接指向 `cloud.example.com`），
 * 刻意别让它看起来像一封真邮件。
 *
 * 走的是 `@xsu/platform` 的源文件而不是包名：仓库根不装依赖，包名从 `scripts/` 解析不到。
 * `.env` 由 `getServerEnv()` 自己载入（`packages/platform/src/env.ts` 的规则 2），这里不必再管。
 */
import {
  closeProducerQueues,
  getProducerQueue,
  getServerEnv,
  JOB_NAME,
} from '../packages/platform/src/index';

const env = getServerEnv();
const queue = getProducerQueue(env);

console.log(`[enqueue] Redis：${new URL(env.redis.url).host}`);

/* 邮件任务：载荷就是 MailMessage。 */
const mail = await queue.add(JOB_NAME.mailSend, {
  to: 'someone@example.com',
  subject: '队列手工回归',
  text: '这封邮件由 scripts/enqueue-manual-jobs.ts 入队。',
  link: 'https://cloud.example.com/verify?token=manual-run',
});
console.log(`[enqueue] ${JOB_NAME.mailSend} id=${mail.id}`);

/* 清理任务：载荷是空对象（见 `queue.ts` 的 CleanupJobData）。 */
const cleanup = await queue.add(JOB_NAME.maintenanceCleanup, {});
console.log(`[enqueue] ${JOB_NAME.maintenanceCleanup} id=${cleanup.id}`);

/* 显式关掉生产者连接，否则 ioredis 会把这个脚本挂在事件循环里不退。 */
await closeProducerQueues();
console.log('[enqueue] 已入队并关闭连接');
