// 浏览器操作串行锁（P-M2 并行子代理安全）
// server-puppeteer 是单一浏览器实例；并行子代理 / 主代理同时操作页面会互相干扰
// （两个 navigate 竞争、browserNavigated 标记被并发读写）。所有 puppeteer_* 调用
// 通过本锁排队执行，保证同一时刻只有一个浏览器操作。非浏览器工具不受影响、可并行。
let tail: Promise<void> = Promise.resolve();

/** 在串行锁内执行浏览器操作：等待队列中前面的操作完成后再运行 fn，运行完释放。 */
export async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => {
    release = r;
  });
  await prev; // 等待前一个浏览器操作完成（tail 始终 resolve，含失败场景，不会锁死）
  try {
    return await fn();
  } finally {
    release(); // 释放锁，让队列中下一个操作开始
  }
}

/** 测试辅助：等待当前队列清空（队列空闲时立即 resolve）。 */
export function browserLockIdle(): Promise<void> {
  return tail;
}
