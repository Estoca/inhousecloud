import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiskUsageScheduler } from '../src/disk-usage-scheduler.js';

test('disk usage scheduler runs once per configured day', async () => {
  let collected = 0;
  const scheduler = createDiskUsageScheduler({
    env: {
      DISK_USAGE_SNAPSHOT_ENABLED: 'true',
      DISK_USAGE_SNAPSHOT_HOUR: '3',
      DISK_USAGE_SNAPSHOT_MINUTE: '0',
      DISK_USAGE_SNAPSHOT_TIMEZONE: 'UTC',
    },
    collectDockerDiskUsageFn: () => {
      collected += 1;
      return {
        available: true,
        rows: [{ container_name: 'app-1' }],
        summary: { containers_count: 1 },
      };
    },
    recordDiskUsageSnapshotFn: async (rows) => ({
      available: true,
      recorded: rows.length,
    }),
    logger: { error: () => {} },
  });

  assert.equal(scheduler.shouldRun(new Date('2026-06-10T02:59:00.000Z')), false);
  assert.equal(scheduler.shouldRun(new Date('2026-06-10T03:00:00.000Z')), true);

  await scheduler.run({ reason: 'scheduled', date: new Date('2026-06-10T03:00:00.000Z') });

  assert.equal(collected, 1);
  assert.equal(scheduler.status().last_recorded, 1);
  assert.equal(scheduler.shouldRun(new Date('2026-06-10T03:30:00.000Z')), false);
  assert.equal(scheduler.shouldRun(new Date('2026-06-11T03:00:00.000Z')), true);
});

test('disk usage scheduler stays disabled unless enabled', () => {
  const scheduler = createDiskUsageScheduler({
    env: {},
    collectDockerDiskUsageFn: () => ({ available: true, rows: [] }),
    recordDiskUsageSnapshotFn: async () => ({ available: true, recorded: 0 }),
    logger: { error: () => {} },
  });

  assert.equal(scheduler.status().enabled, false);
  assert.equal(scheduler.shouldRun(new Date('2026-06-10T03:00:00.000Z')), false);
});
