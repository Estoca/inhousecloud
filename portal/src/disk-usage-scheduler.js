import { readPlatformConfig } from './config.js';

function cleanBoolean(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dateKey: `${byType.year}-${byType.month}-${byType.day}`,
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

export function createDiskUsageScheduler({
  env = process.env,
  collectDockerDiskUsageFn,
  recordDiskUsageSnapshotFn,
  logger = console,
} = {}) {
  const enabled = cleanBoolean(env.DISK_USAGE_SNAPSHOT_ENABLED);
  const hour = numberOrDefault(env.DISK_USAGE_SNAPSHOT_HOUR, 3);
  const minute = numberOrDefault(env.DISK_USAGE_SNAPSHOT_MINUTE, 0);
  const timeZone = env.DISK_USAGE_SNAPSHOT_TIMEZONE || readPlatformConfig(env).timezone;
  const pollMs = Math.max(numberOrDefault(env.DISK_USAGE_SNAPSHOT_POLL_MS, 10 * 60 * 1000), 60 * 1000);
  const state = {
    enabled,
    hour,
    minute,
    timeZone,
    poll_ms: pollMs,
    last_run_at: null,
    last_run_date: null,
    last_error: null,
    last_recorded: null,
    running: false,
  };
  let timer = null;

  async function run({ reason = 'manual', date = new Date() } = {}) {
    if (state.running) return { skipped: true, reason: 'already_running' };
    state.running = true;
    state.last_error = null;
    try {
      const collection = collectDockerDiskUsageFn();
      if (!collection.available) {
        throw new Error(collection.error || 'disk usage collection unavailable');
      }
      const result = await recordDiskUsageSnapshotFn(collection.rows);
      if (!result.available) {
        throw new Error(result.error || 'disk usage snapshot unavailable');
      }
      const now = date;
      state.last_run_at = now.toISOString();
      state.last_run_date = zonedDateParts(now, timeZone).dateKey;
      state.last_recorded = result.recorded;
      return {
        skipped: false,
        reason,
        recorded: result.recorded,
        summary: collection.summary,
      };
    } catch (error) {
      state.last_error = error.message;
      logger.error?.('disk usage snapshot failed', error);
      return {
        skipped: false,
        reason,
        error: error.message,
      };
    } finally {
      state.running = false;
    }
  }

  function shouldRun(date = new Date()) {
    if (!state.enabled) return false;
    const parts = zonedDateParts(date, timeZone);
    if (state.last_run_date === parts.dateKey) return false;
    return parts.hour === hour && parts.minute >= minute;
  }

  function tick(date = new Date()) {
    if (!shouldRun(date)) return;
    void run({ reason: 'scheduled', date });
  }

  function start() {
    if (!state.enabled || timer) return;
    timer = setInterval(() => tick(), pollMs);
    timer.unref?.();
    tick();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function status() {
    return { ...state, started: Boolean(timer) };
  }

  return {
    run,
    shouldRun,
    start,
    status,
    stop,
    tick,
  };
}
