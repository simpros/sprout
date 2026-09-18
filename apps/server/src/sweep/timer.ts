export type SweepTimerOptions = {
  intervalMs: number;
  runPass: () => Promise<void>;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

export type SweepTimerHandle = {
  stop: () => void;
};

export function startSweepTimer(options: SweepTimerOptions): SweepTimerHandle {
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  const cancelInterval = options.clearInterval ?? clearInterval;

  let stopped = false;
  let inFlight = false;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await options.runPass();
    } catch (error) {
      options.onError?.(error);
    } finally {
      inFlight = false;
    }
  };

  timeoutId = scheduleTimeout(() => {
    timeoutId = undefined;
    if (stopped) return;
    void run();
    intervalId = scheduleInterval(() => {
      void run();
    }, options.intervalMs);
  }, options.intervalMs);

  return {
    stop() {
      stopped = true;
      if (timeoutId !== undefined) cancelTimeout(timeoutId);
      if (intervalId !== undefined) cancelInterval(intervalId);
      timeoutId = undefined;
      intervalId = undefined;
    },
  };
}
