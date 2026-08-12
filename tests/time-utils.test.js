const test = require('node:test');
const assert = require('node:assert/strict');

const TimeUtils = require('../time-utils');

test('Beijing date and time remain correct around UTC midnight', () => {
  const beforeBeijingMidnight = new Date('2026-08-12T15:59:59.000Z');
  const afterBeijingMidnight = new Date('2026-08-12T16:00:01.000Z');

  assert.equal(TimeUtils.getBeijingDateStr(beforeBeijingMidnight), '2026-08-12');
  assert.equal(TimeUtils.getBeijingTimeStr(beforeBeijingMidnight), '23:59:59');
  assert.equal(TimeUtils.getBeijingDateStr(afterBeijingMidnight), '2026-08-13');
  assert.equal(TimeUtils.getBeijingTimeStr(afterBeijingMidnight), '00:00:01');
  assert.equal(TimeUtils.formatDate(afterBeijingMidnight), '2026年8月13日 星期四');
});

test('bedtime countdown uses the same Beijing day and stops at zero', () => {
  const beforeBedtime = new Date('2026-08-12T12:00:00.000Z'); // Beijing 20:00
  const afterBedtime = new Date('2026-08-12T14:00:00.000Z'); // Beijing 22:00

  assert.equal(TimeUtils.getSecondsToBedtime('21:30', beforeBedtime), 90 * 60);
  assert.equal(TimeUtils.getSecondsToBedtime('21:30', afterBedtime), 0);
});

test('family bedtime rules distinguish Beijing weekdays and weekends', () => {
  const settings = { bedtime: '21:30', weekendBedtime: '22:15' };

  assert.equal(TimeUtils.getBedtimeForDate(settings, '2026-08-14'), '21:30'); // Friday
  assert.equal(TimeUtils.getBedtimeForDate(settings, '2026-08-15'), '22:15'); // Saturday
  assert.equal(TimeUtils.getBedtimeForDate(settings, '2026-08-16'), '22:15'); // Sunday
  assert.equal(TimeUtils.getBedtimeForDate({ bedtime: '21:45' }, '2026-08-15'), '21:45');
});

test('duration formatting floors fractional seconds consistently', () => {
  assert.equal(TimeUtils.formatDuration(0), '0 分钟');
  assert.equal(TimeUtils.formatDuration(61.9), '1 分钟 1 秒');
  assert.equal(TimeUtils.formatDuration(3600), '1 小时');
  assert.equal(TimeUtils.formatDurationShort(3660), '1h1m');
});
