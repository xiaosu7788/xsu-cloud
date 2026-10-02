'use client';

/**
 * 注册 Service Worker；有新版本时给出一条提示条。
 *
 * ## 为什么必须用户确认，而不是自动刷新
 *
 * `public/sw.js` 采用「新版本停在 waiting、等用户点刷新」的策略（理由写在那个文件头部，
 * 对应 `docs/PRD.md` 4.3「更新策略必须明确定义」）。这里就是那个策略的用户侧接口。
 * 自动刷新在这里是不能接受的：用户可能正停在表单页填一屏字，或者正在上传文件，
 * 一次静默 reload 会把未提交的输入全部丢掉，而用户根本不知道发生了什么 ——
 * 用「不许用户长期运行旧代码」换「随机丢数据」不划算。所以只提示，不代劳。
 *
 * ## 为什么开发态不注册
 *
 * `next dev` 的产物 URL 在热更新下不稳定（chunk 会被替换、新增），一旦被 SW 缓存住，
 * 服务端给的新 HTML 会去请求旧 chunk，表现为「改了代码页面没变」甚至 chunk 404。
 * 这类幽灵 bug 的排查成本远高于在开发态手动验证 SW 的价值，因此非 production 直接返回。
 *
 * ## 为什么提示条要避让底部导航
 *
 * 提示条必须压在页面之上（`fixed`），否则用户永远看不到它；但移动端底部还有一条 Tab 栏，
 * 两者贴同一个 `bottom-0` 就会互相盖住 —— 盖住 Tab 栏等于把主航线的入口挡掉，
 * 比看不到更新提示严重得多。具体数值与假设见下面 `BAR_CONTAINER` / `BAR_CARD_OFFSET` 常量。
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/utils';

/**
 * 移动端底部导航的避让数值。
 *
 * 假设（尚未有真实 Tab 栏实现，M1 落地后需按实际高度复核）：
 *
 * - Tab 栏自身高 `3.5rem`（56px），并且自己吃掉 `env(safe-area-inset-bottom)`，
 *   即它占住从视口底部起 `3.5rem + safe-area` 这一条带；
 * - 因此本组件容器贴 `bottom-0`，内层卡片在移动端再抬 `mb-14`（`14` = 3.5rem），
 *   底边距视口底部 = `3.5rem + safe-area + 0.75rem`，比 Tab 栏顶部高 12px，留出视觉间隙；
 * - 容器自身的 `pb-[calc(env(safe-area-inset-bottom)+0.75rem)]` 保证卡片不压住 iOS 的
 *   手势区 / 安卓的导航条；`md` 及以上底部导航按桌面布局收起，改为贴底 `md:mb-0` + `md:pb-4`。
 *
 * 层级用 `z-40`：让对话框、toast 这些 `z-50` 的浮层仍然压在提示条之上。
 */
/** 提示条容器的定位与安全区内边距。 */
const BAR_CONTAINER =
  'fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:pb-4';

/** 提示条卡片自身的盒模型与配色，不含位置。 */
const BAR_CARD =
  'mx-auto flex max-w-md items-center gap-3 rounded-lg border border-border bg-background p-3 shadow-lg';

/**
 * 移动端避让底部导航的那一份偏移：`mb-14` = 3.5rem，对应上面假设的 Tab 栏高度；
 * 桌面端没有底部导航，`md:mb-0` 贴底。单独取出来并用 `cn` 合并，是为了让「避让」这件事
 * 在代码里只有一个改动点，且不会被卡片基类里的间距类覆盖（`cn` 里 tailwind-merge 保证后者生效）。
 */
const BAR_CARD_OFFSET = 'mb-14 md:mb-0';

export function ServiceWorkerRegistrar() {
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadedRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    /*
     * 新 SW 接管后才 reload。只 reload 一次：`controllerchange` 在多个标签页、
     * 多次 claim 的情况下会重复触发，不设哨兵会变成连续刷新。
     */
    const handleControllerChange = () => {
      if (reloadedRef.current) return;
      reloadedRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registrationRef.current = registration;

        /*
         * 用户上次点了「稍后」之后又刷新了页面：新 SW 已经停在 waiting，
         * 此时不会再触发 updatefound，只能主动读一次，否则提示条再也不会出现。
         */
        if (registration.waiting) {
          setUpdateReady(true);
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            /*
             * 两个条件缺一不可：
             * - `installed`：新版本装完，进入 waiting 等接管；
             * - `controller` 存在：说明当前有旧版本在跑，这是「更新」；首次安装没有旧版本，
             *   弹「有新版本」是假消息。
             */
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        });
      })
      .catch((error: unknown) => {
        /*
         * 不吞错误：注册失败（脚本 404、被安全策略拒绝、非 HTTPS）要能在控制台看到原因。
         * 也不往上抛：这不是渲染期错误，抛出去会让整棵组件树崩掉，而 SW 只是一层增强，
         * 用户本来能正常用页面。
         */
        console.error('[service-worker] 注册 /sw.js 失败', error);
      });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      /*
       * 拿不到 waiting worker（注册还没完成，或它已被系统回收）：按钮对用户承诺的是
       * 「刷新」，此时直接重载，至少行为与文案一致。
       */
      window.location.reload();
      return;
    }

    /*
     * 只发消息，不等这里 reload：`skipWaiting()` 是异步的，立刻 reload 可能仍拿到
     * 旧 controller 的产物。真正的重载交给上面的 `controllerchange`。
     */
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, []);

  if (!updateReady) return null;

  return (
    <div className={BAR_CONTAINER}>
      <div className={cn(BAR_CARD, BAR_CARD_OFFSET)}>
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm text-foreground">
          有新版本，点击刷新
        </p>
        <Button type="button" onClick={handleRefresh} className="shrink-0">
          <RefreshCw aria-hidden />
          刷新
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setUpdateReady(false)}
          className="shrink-0"
        >
          稍后
        </Button>
      </div>
    </div>
  );
}
