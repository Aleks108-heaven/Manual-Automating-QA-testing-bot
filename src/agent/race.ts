// Waiting for a call, but giving up as soon as the kill switch is engaged. It lives in its own file because the agent loop, the
// judge and the final report all use it, and the loop imports the judge.
import type { PauseSource } from "../ops/kill-switch.ts";

export const KILLED = Symbol("killed");

/**
 * Waits for a promise, but gives up as soon as the kill switch is engaged. Polls the switch every 100 ms, so a
 * model call or a tool call that is stuck cannot keep a paused runner busy.
 */
export function raceKill<T>(promise: Promise<T>, pause: PauseSource | undefined): Promise<T | typeof KILLED> {
  if (!pause) return promise;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (pause.isPaused()) {
        clearInterval(timer);
        resolve(KILLED);
      }
    }, 100);
    promise.then(
      (value) => {
        clearInterval(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearInterval(timer);
        reject(error);
      },
    );
  });
}
