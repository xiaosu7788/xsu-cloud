/**
 * worker 进程入口（`docs/ARCHITECTURE.md` 7.3：与应用同代码、不同入口）。
 *
 * 启动方式：`pnpm --filter @xsu/web worker`（内部是 `tsx worker/index.ts`）。
 * 部署时它是与应用容器**同镜像、不同 command** 的一个进程——这是「同语言同类型、
 * 需要时整块搬走」那条分层理由在运维上的落点。
 *
 * ## 本进程不监听端口
 *
 * 它不处理 HTTP，也没有路由。全部工作是从 Redis 取任务交给 `./handlers` 里装配好的
 * 处理函数：「怎么排队」在 `@xsu/platform` 的 `./queue`，「任务里做什么」在 `./handlers`，
 * 本文件只管**进程生命周期**：起、等、收。
 *
 * ## 为什么顶层直接启动，不加 main() 守卫
 *
 * 它是入口而不是库：仓库里没有任何模块 import 它，所以「被 import 就启动」不会发生。
 * 加一层 `import.meta.url === pathToFileURL(process.argv[1])` 的判断只会给启动路径
 * 多一处能在生产上出错的地方（`tsx`、`node --import tsx`、容器里的 command 三种
 * 调用方式下 `argv[1]` 的值并不一致）。
 *
 * ## 退出语义
 *
 * - **SIGTERM / SIGINT：优雅收尾**。先停消费者与调度器再关连接，正在执行的任务跑完，
 *   队列里没取到的任务留在 Redis 里等下次启动——退出码 0。收到第二个信号则不再等待
 *   （见下文的防重入），避免「发了 SIGTERM 但进程卡住、只能 SIGKILL」。
 * - **未捕获异常 / 未处理的 Promise：立刻失败退出**，退出码 1，交给进程管理器重启。
 *   这里刻意不 try/catch 之后继续跑：一个已经不知道自己处在什么状态的进程继续消费队列，
 *   只会把失败摊得更大（与 `docs/PRD.md` 3.3 验收 1「不伪成功」同一条理由）。
 * - **配置错误在启动时就抛**（`getServerEnv()` 的既有行为），进程不会带着半份配置跑起来。
 * - 进程级故障不在这里重试，重试是队列对**单条任务**的职责（`MAIL_JOB_OPTIONS`）。
 */
import { getServerEnv, startQueueWorkers, type RunningQueueWorkers } from '@xsu/platform';

import { createWorkerHandlers } from './handlers';

/** 与 `@xsu/platform` 的 `log` 同一个出口：写 stdout，一行一条。 */
function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 收到几次终止信号。
 *
 * 第一次：优雅收尾。第二次：用户或编排工具已经等不及了，直接退出——此时退出码仍是 0，
 * 因为「第二次信号」表达的是「别再等了」，不是「出了错」。
 */
let shutdownSignals = 0;

async function main(): Promise<void> {
  const env = getServerEnv();

  log(`[worker] 启动：${env.nodeEnv}，队列 Redis ${new URL(env.redis.url).host}`);

  const running = await startQueueWorkers({
    env,
    handlers: createWorkerHandlers({ env, log }),
    log,
  });

  log('[worker] 已就绪，等待任务');

  const shutdown = (signal: NodeJS.Signals): void => {
    shutdownSignals += 1;

    if (shutdownSignals > 1) {
      log(`[worker] 再次收到 ${signal}，不再等待，直接退出`);
      process.exit(0);
    }

    log(`[worker] 收到 ${signal}，停止取新任务并等待当前任务完成`);
    void closeAndExit(running);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (error) => {
    log(`[worker] 未捕获异常，进程退出：${error.stack ?? error.message}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log(`[worker] 未处理的 Promise 拒绝，进程退出：${String(reason)}`);
    process.exit(1);
  });
}

/**
 * 收尾。
 *
 * `close()` 失败也要退出：此时已经决定不干了，留着一个「关不干净但仍然活着」的进程
 * 没有意义——挂在那里比干干净净地退出更糟。所以这里吞掉 close 的异常，但要**把原因
 * 写进日志**（吞异常与吞日志是两件事，前者是设计，后者是隐瞒现场）。
 */
async function closeAndExit(running: RunningQueueWorkers): Promise<void> {
  try {
    await running.close();
    log('[worker] 已停止');
  } catch (error) {
    log(
      `[worker] 收尾时报错（仍会退出）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exit(0);
}

/*
 * 顶层调用：见文件头「为什么顶层直接启动」。`main()` 内部的失败（配置错误、Redis 连不上、
 * 调度器注册失败）走到 unhandledRejection 分支，以退出码 1 结束——启动失败必须是失败。
 */
void main();
