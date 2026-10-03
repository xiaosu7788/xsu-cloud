/**
 * worker 的任务实现：`mail.send` 与 `maintenance.cleanup`。
 *
 * ## 为什么在应用层，而不在 `@xsu/platform`
 *
 * `packages/platform/src/queue.ts` 只提供「怎么排队」的机制，任务内容由消费者注入；
 * `packages/platform/src/maintenance.ts` 只提供「怎么清理」的机制。把两者接起来并决定
 * 「谁来发邮件、谁来跑清理」是装配，属于应用层。平台层因此不必知道自己被谁用。
 *
 * ## 邮件走哪条传输
 *
 * 默认是控制台传输（`@xsu/platform` 的 `createConsoleMailTransport`）：M2 没有真实 SMTP，
 * 它在**生产环境会抛错**。这不是缺陷，是刻意的——「邮件没接上」必须表现为任务失败并重试，
 * 而不是一个静默成功的日志。真实 SMTP 属集成层，见 `docs/INTEGRATIONS.md` 第 4 节。
 * 换成真实传输时只改这里的默认值，`queue.ts` 与领域层都不用动。
 *
 * ## 处理函数不吞异常
 *
 * 返回即成功、抛错即失败并触发重试（`QueueWorkerHandlers` 的约定）。因此这里**没有**
 * 任何 `catch`：清理失败就该让任务进 failed 并在日志里留下现场，而不是把
 * 「删了 0 行」写进日志当成完成。
 */
import {
  createConsoleMailTransport,
  JOB_NAME,
  runMaintenanceCleanup,
  type MailTransport,
  type QueueWorkerHandlers,
  type ServerEnv,
} from '@xsu/platform';

/** 装配任务实现需要的东西。全部可注入，测试可以替换邮件端口与日志出口。 */
export type WorkerHandlerDeps = {
  env: ServerEnv;
  /** 默认按环境取控制台传输（见文件头）。 */
  transport?: MailTransport;
  /** 默认写 stdout。与 `startQueueWorkers` 的 `log` 是同一个出口。 */
  log?: (line: string) => void;
};

/**
 * 建一组处理函数。
 *
 * 用计算属性名（`[JOB_NAME.mailSend]`）而不是字符串字面量：任务名只在 `queue.ts` 定义一处，
 * 拼错名字在这里就是编译错误，而不是「任务永远没人处理」这种只在生产上才发现的故障。
 */
export function createWorkerHandlers(deps: WorkerHandlerDeps): QueueWorkerHandlers {
  const env = deps.env;
  const transport = deps.transport ?? createConsoleMailTransport(env);
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  return {
    [JOB_NAME.mailSend]: async (message) => {
      await transport.send(message);
    },

    [JOB_NAME.maintenanceCleanup]: async () => {
      const result = await runMaintenanceCleanup({ env });
      /*
       * 删了多少行是这条任务的唯一产出，必须进日志：清理出问题时（比如保留期配错、删得
       * 异常多）第一个要看的就是这个数字。日志里只有计数与保留期，没有邮箱、没有摘要。
       */
      log(
        `[maintenance] 清理完成：过期会话 ${result.sessions} 行、运行历史 ${result.toolRuns} 行` +
          `（保留 ${env.tools.retentionDays} 天）`,
      );
    },
  };
}
