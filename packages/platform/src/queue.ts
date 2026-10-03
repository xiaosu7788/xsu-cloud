/**
 * 队列（BullMQ）。M2 首次落地，位置与理由见 `docs/ARCHITECTURE.md` 第 7.3 节。
 *
 * 本文件只提供「怎么排队」的机制：队列名、任务名、连接、生产者、消费者装配。
 * **任务里做什么（发邮件、清理什么）不在这里**——那是应用层的事，交给
 * `apps/web/worker/index.ts` 注入。所以这里既不含业务规则，也不 import `apps/web`。
 *
 * ## 一、为什么每个角色都自己造 ioredis 实例
 *
 * BullMQ 的 `loadIORedis()`（`bullmq@6.3.11` 的
 * `dist/esm/classes/redis-connection.js` 第 33-63 行）走的是 `require('ioredis')`。
 * 本项目到处是原生 ESM（`"type": "module"`、tsx、Next 的服务端图），那里没有 `require`，
 * 于是它会抛「BullMQ could not load the optional 'ioredis' package」——**而 ioredis 其实装着**。
 * 库自己的错误信息给了正解：传一个已经建好的客户端实例。因此本文件**一律传实例**，
 * 不接受 `{ url: ... }` 这种连接选项写法。改这里之前先看那段源码。
 *
 * ## 二、生产者与消费者的连接配置不能共用
 *
 * 消费者的阻塞式取任务要求 `maxRetriesPerRequest: null`。这一条由 BullMQ 强制：传入实例时
 * 它会读该实例的 `options` 再检查（同文件第 136、163-171 行，`throwError = true`），
 * 不满足**直接抛错**，而不是打条日志了事。传连接选项时则是它自己把这一项改成 `null`
 * （同文件第 116-118 行）——两种写法结果一致，但只有传实例这条路在 ESM 下走得通。
 *
 * 生产者恰好相反：它的命令跑在用户请求路径上（注册时入队验证邮件），要求**快速失败**——
 * Redis 连不上时立刻报错，而不是把请求挂在那里等重连。所以生产者关掉离线队列
 * （`enableOfflineQueue: false`），消费者保持默认。这个差异是有意的，不是漏配：
 * 「注册成功但邮件没进队列」正是 `docs/PRD.md` 3.3 验收 1 明确拒绝的伪成功。
 *
 * ## 三、连接都是懒的
 *
 * 导入本模块不会连 Redis：`Queue` 与 `Worker` 都在第一次用到时才建。Next 的页面渲染图里
 * 只是 import 到本模块时，不应该多出一条 Redis 连接。
 *
 * ## 四、连接是我们建的，所以由我们关
 *
 * BullMQ 只**借用**调用方传入的客户端：`redis-connection.js` 的 `close()`（第 491 行）在
 * `extraOptions.shared` 为真时既不 `quit` 也不 `disconnect`，而传实例就意味着 `shared` 为真。
 * 于是 `queue.close()` / `worker.close()` 跑完之后，进程里仍然挂着我们建的 ioredis 连接——
 * 表现是「worker 收到 SIGTERM 后不退出」。所以本文件把每个实例都留在手上，关队列时一起关。
 */
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

import type { ServerEnv } from './env';
import type { MailMessage, MailTransport } from './mail';

/** 队列名。只此一份：改动它会丢掉所有正在等待的任务。 */
export const QUEUE_NAME = 'xsu';

/**
 * 任务名。
 *
 * 与领域层的失败码表同一条纪律：**名字在这里定义，调用点不写字面量**。
 * 消费者按名字分派，拼错一个字母就是「任务永远没人处理」这种只在生产上才发现的故障。
 */
export const JOB_NAME = {
  /** 发一封邮件。载荷就是 `MailMessage`。 */
  mailSend: 'mail.send',
  /** 定期维护：删过期会话、删超出保留期的运行历史。载荷为空对象。 */
  maintenanceCleanup: 'maintenance.cleanup',
} as const;

/** 发邮件任务的载荷。直接用邮件端口的类型，避免同一件事有两份字段定义。 */
export type MailJobData = MailMessage;

/** 维护任务的载荷。刻意是空对象而不是 `undefined`：BullMQ 用 JSON 序列化，`undefined` 会丢。 */
export type CleanupJobData = Record<string, never>;

/**
 * 任务名 → 载荷。加任务时在这里加一行，消费者与入队侧会一起被编译器检查。
 */
export type JobData = {
  [JOB_NAME.mailSend]: MailJobData;
  [JOB_NAME.maintenanceCleanup]: CleanupJobData;
};

export type JobName = keyof JobData;

/** 队列里可能出现的一种载荷。生产者按 `JobName` 取窄类型，消费者面对的是这个联合。 */
export type JobPayload = JobData[JobName];

/**
 * 清理任务的执行计划：每天 04:00。
 *
 * **显式声明 UTC**，不跟随服务器本地时区：机房位置是 `AGENTS.md` 第 8 节里唯一未决的事项，
 * 换机房不该让清理时间跟着漂移。tz 的取值见 BullMQ 的 `RepeatOptions`。
 */
export const CLEANUP_CRON = '0 4 * * *';

/** `CLEANUP_CRON` 的解释时区。见上一条。 */
export const CLEANUP_TIMEZONE = 'UTC';

/**
 * 生产者的连接：**快速失败**（见文件头第二条）。
 *
 * 不设 `maxRetriesPerRequest`，用 ioredis 的默认值。生产者不阻塞取任务，
 * BullMQ 也不会强制它必须是 `null`，而 `null` 会让「Redis 半死不活」时的入队请求一直挂着。
 */
function createProducerConnection(env: ServerEnv): Redis {
  return new Redis(env.redis.url, {
    connectionName: 'xsu-queue-producer',
    // 连不上就立刻报错，别把用户请求排队等重连。
    enableOfflineQueue: false,
  });
}

/**
 * 消费者的连接：`maxRetriesPerRequest: null` **不是可选项**，BullMQ 会检查并抛错（文件头第二条）。
 */
function createWorkerConnection(env: ServerEnv): Redis {
  return new Redis(env.redis.url, {
    connectionName: 'xsu-queue-worker',
    maxRetriesPerRequest: null,
  });
}

/**
 * 关掉一个 ioredis 实例。**谁建谁关**（见文件头第四条）。
 *
 * `quit()` 需要能把命令发出去；连接已经断了的时候它会抛错，那时只剩强制断开一条路。
 * 先用 `status` 判断能省掉这种往返——`'end'` 是 ioredis 的终态。
 */
async function closeRedis(connection: Redis): Promise<void> {
  if (connection.status === 'end') return;
  try {
    await connection.quit();
  } catch {
    /*
     * 走到这里说明连接已经不可用（对端掉了，或者从来没连上过）。`quit` 失败本身不是要上报的
     * 错误：退出流程只关心「进程能不能干净退出」，不关心是谁先断的。强制断开保证这一点；
     * 真要排障，用 `connectionName` 去 Redis 侧看连接记录。
     */
    connection.disconnect();
  }
}

/**
 * 各类任务的保留策略。
 *
 * 与 `tool_runs` 的保留期同一条理由：队列是**过程**记录，不是账本，成功之后留着只有
 * 排障价值，而 BullMQ 把已完成的任务留在 Redis 里，不清就会一直长。
 * 失败的多留一会儿（24 小时），因为那才是需要回头看的东西。
 */
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 60 * 60 },
};

/** 邮件任务：失败重试 3 次，指数退避。邮件是「用户知道要收」的东西，值得多试几次。 */
const MAIL_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
};

/** 清理任务：重试 2 次就够。它是幂等的，下一次调度还会再来一遍。 */
const CLEANUP_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  // 一天一条，留 30 条 = 一个月的执行痕迹。
  removeOnComplete: { count: 30 },
};

/**
 * 进程内共享的生产者队列，按 Redis 地址缓存。
 *
 * **连接和队列存在一起**：只留 `Queue` 的话，退出时就没法关掉它底下那条连接了
 * （文件头第四条）。
 *
 * `getServerEnv()` 在一个进程里只解析一次，所以正常只有一个键；按地址缓存是为了让
 * 「不同配置各拿各的队列」这件事在测试里也成立，而不是让第二次调用悄悄复用第一次的连接。
 */
type ProducerEntry = {
  queue: Queue<JobPayload, void, JobName>;
  /** 我们自己建的连接。BullMQ 借用它，但不负责关闭。 */
  connection: Redis;
};

const producerQueues = new Map<string, ProducerEntry>();

/** 取（或建）生产者队列。**入队是唯一目的**，这个实例不消费任务。 */
export function getProducerQueue(env: ServerEnv): Queue<JobPayload, void, JobName> {
  const cached = producerQueues.get(env.redis.url);
  if (cached) return cached.queue;

  const connection = createProducerConnection(env);
  const queue = new Queue<JobPayload, void, JobName>(QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  producerQueues.set(env.redis.url, { queue, connection });
  return queue;
}

/**
 * 邮件端口的一个实现：**把邮件塞进队列就返回**，不在这里发。
 *
 * 与 `createConsoleMailTransport` 的差别是「什么时候算发送成功」：控制台传输返回时邮件
 * 已经打出来了；这里返回时邮件只是**排上了队**，真正的发送与重试由 worker 兜。
 * 这个变化是 `docs/spec/SPEC-tools.md` 第 5 节写明的既有取舍，不是实现细节。
 *
 * 反过来说：这里**不吞异常**。Redis 连不上就让注册请求失败并报错，
 * 而不是返回一个「注册成功、邮件在路上」的假象（`docs/PRD.md` 3.3 验收 1）。
 */
export function createQueuedMailTransport(env: ServerEnv): MailTransport {
  return {
    async send(message) {
      await getProducerQueue(env).add(JOB_NAME.mailSend, message, MAIL_JOB_OPTIONS);
    },
  };
}

/**
 * 每个任务名的处理函数。**返回即成功，抛错即失败并触发重试**——
 * 所以处理函数里不许 `catch` 之后什么也不说，那会把失败伪装成完成。
 */
export type QueueWorkerHandlers = {
  [Name in JobName]: (data: JobData[Name]) => Promise<void>;
};

export type QueueWorkerOptions = {
  env: ServerEnv;
  handlers: QueueWorkerHandlers;
  /** 启动与任务结果记在哪里。默认写 stdout，测试可换成收集数组。 */
  log?: (line: string) => void;
};

/**
 * 一条任务的判别联合：`name` 与 `data` 绑在一起。
 *
 * 拆开写（`{ name: JobName; data: JobPayload }`）的话，`dispatchJob` 里的 `switch (job.name)`
 * 收窄不了 `job.data`，每个分支都得多一次断言——把一个缺口摊成几份。
 */
export type JobInput = { [Name in JobName]: { name: Name; data: JobData[Name] } }[JobName];

/**
 * 按任务名分派。**这是本文件唯一的逻辑**，抽成独立函数是为了能在没有 Redis 的环境里单测：
 * 提交级检查（`pnpm test`）不起 Redis 服务，而 `new Queue(...)` 一建就发起连接——
 * 文件头第三条说的「懒」是模块级的：`import` 不连，用到才连。
 *
 * 处理函数抛错就**原样往外抛**：返回即成功，抛错即失败并触发重试（见 `QueueWorkerHandlers`）。
 * 这里不 `try`、不兜底——兜住等于把失败说成完成（`docs/PRD.md` 3.3 验收 1）。
 */
export async function dispatchJob(
  handlers: QueueWorkerHandlers,
  job: JobInput,
  log: (line: string) => void,
): Promise<void> {
  switch (job.name) {
    case JOB_NAME.mailSend:
      await handlers[JOB_NAME.mailSend](job.data);
      log(`[queue] ${JOB_NAME.mailSend} 完成：${job.data.subject}`);
      return;
    case JOB_NAME.maintenanceCleanup:
      await handlers[JOB_NAME.maintenanceCleanup](job.data);
      log(`[queue] ${JOB_NAME.maintenanceCleanup} 完成`);
      return;
  }

  /*
   * 类型上到不了（`JobInput` 是判别联合）。留着是为了「升级时旧进程还在消费新任务名」这种
   * 真实场景：那时返回成功等于静默把任务丢掉了，抛错会重试并最终进 failed——比伪成功诚实。
   */
  throw new Error(`未知任务名：${String((job as { name?: unknown }).name)}`);
}
/** 消费者句柄。入口在 SIGTERM / SIGINT 时调 `close()`，否则进程不会退出。 */
export type RunningQueueWorkers = {
  worker: Worker<JobPayload, void, JobName>;
  /**
   * 停掉消费者与调度器。
   *
   * **两处连接都得自己关**：worker 的阻塞连接，以及生产者队列底下那条连接——它们都是本
   * 文件建的，而 BullMQ 只借用调用方传入的客户端（见文件头第四条）。少关一条，进程就不会退出。
   */
  close: () => Promise<void>;
};

/**
 * 起一个消费者进程。
 *
 * 同时**注册重复任务**（清理）：用 `upsertJobScheduler` 而不是 `add` 一条 repeat 配置——
 * 前者是幂等的，进程重启不会在 Redis 里留下第二份调度；后者在 BullMQ 6 里已经属于旧写法。
 *
 * `concurrency: 1`：M2 的两个任务一个是一天一次，一个是「注册时才来一封」，
 * 并发度对它们没有意义，而单条让日志顺序与失败现场都更好读。真需要并发时再调。
 */
export async function startQueueWorkers(options: QueueWorkerOptions): Promise<RunningQueueWorkers> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const handlers = options.handlers;
  /* 消费者的连接要留在手上，`close()` 时自己关（文件头第四条）。 */
  const workerConnection = createWorkerConnection(options.env);

  const worker = new Worker<JobPayload, void, JobName>(
    QUEUE_NAME,
    async (job: Job<JobPayload, void, JobName>) => {
      /*
       * 全文件唯一的类型缺口。BullMQ 的 `Job<DataType, ResultType, NameType>` 里 `name` 与
       * `data` 是两个独立的联合，类型系统不知道「name 是 mail.send 时 data 一定是 MailMessage」。
       * 数据只可能来自本仓库的生产者（按 `JobData` 写入，没有第三方来源），所以断言收在这一行，
       * `dispatchJob` 内部就能按判别联合写。升级 BullMQ 时先回来看这里。
       */
      await dispatchJob(handlers, { name: job.name, data: job.data } as JobInput, log);
    },
    {
      connection: workerConnection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, error) => {
    log(
      `[queue] 任务失败：${job?.name ?? '(未知)'} 第 ${job?.attemptsMade ?? 0} 次 —— ${error.message}`,
    );
  });
  worker.on('error', (error) => {
    log(`[queue] 连接错误：${error.message}`);
  });

  const schedulerQueue = getProducerQueue(options.env);
  await schedulerQueue.upsertJobScheduler(
    JOB_NAME.maintenanceCleanup,
    { pattern: CLEANUP_CRON, tz: CLEANUP_TIMEZONE },
    { name: JOB_NAME.maintenanceCleanup, data: {}, opts: CLEANUP_JOB_OPTIONS },
  );
  log(`[queue] 已注册 ${JOB_NAME.maintenanceCleanup}：${CLEANUP_CRON}（${CLEANUP_TIMEZONE}）`);

  return {
    worker,
    close: async () => {
      await worker.close();
      // 消费者那条阻塞连接同样是我们建的：不关，进程收到信号后不会退出。
      await closeRedis(workerConnection);
      const entry = producerQueues.get(options.env.redis.url);
      if (entry) {
        producerQueues.delete(options.env.redis.url);
        await closeProducerQueueEntry(entry);
      }
    },
  };
}

/** 关掉一个生产者队列及其连接。**顺序有意义**：先关队列，再关它底下的连接。 */
async function closeProducerQueueEntry(entry: ProducerEntry): Promise<void> {
  await entry.queue.close();
  await closeRedis(entry.connection);
}

/** 测试与退出流程用：把缓存的生产者队列全部关掉。生产代码不需要调它。 */
export async function closeProducerQueues(): Promise<void> {
  const entries = [...producerQueues.values()];
  producerQueues.clear();
  await Promise.all(entries.map((entry) => closeProducerQueueEntry(entry)));
}
