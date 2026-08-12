(function exposeTimeUtils(root, factory) {
  const timeUtils = factory();
  if (typeof module === 'object' && module.exports) module.exports = timeUtils;
  if (root) root.TimeUtils = timeUtils;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTimeUtils() {
  return {
    getParts(date = new Date()) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        weekday: 'short'
      }).formatToParts(date);
      return Object.fromEntries(parts.map(part => [part.type, part.value]));
    },

    getBeijingNow() {
      return new Date();
    },

    formatTime(date) {
      const parts = this.getParts(date);
      return `${parts.hour}:${parts.minute}:${parts.second}`;
    },

    formatDate(date) {
      const parts = this.getParts(date);
      const weekdayMap = { Sun: '日', Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六' };
      return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 星期${weekdayMap[parts.weekday]}`;
    },

    getBeijingDateStr(date) {
      const parts = this.getParts(date || this.getBeijingNow());
      return `${parts.year}-${parts.month}-${parts.day}`;
    },

    getBeijingTimeStr(date) {
      const parts = this.getParts(date || this.getBeijingNow());
      return `${parts.hour}:${parts.minute}:${parts.second}`;
    },

    getBedtimeDate(bedtimeStr, now = this.getBeijingNow()) {
      const [hour, minute] = bedtimeStr.split(':').map(Number);
      const parts = this.getParts(now);
      const currentSeconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
      const bedtimeSeconds = hour * 3600 + minute * 60;
      return new Date(now.getTime() + (bedtimeSeconds - currentSeconds) * 1000);
    },

    getSecondsToBedtime(bedtimeStr, now = this.getBeijingNow()) {
      const bedtime = this.getBedtimeDate(bedtimeStr, now);
      return Math.max(0, Math.floor((bedtime - now) / 1000));
    },

    formatDuration(totalSeconds) {
      if (totalSeconds <= 0) return '0 分钟';
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = Math.floor(totalSeconds % 60);

      if (hours > 0) {
        return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
      }
      if (minutes > 0) {
        return seconds > 0 ? `${minutes} 分钟 ${seconds} 秒` : `${minutes} 分钟`;
      }
      return `${seconds} 秒`;
    },

    formatDurationShort(totalSeconds) {
      if (totalSeconds <= 0) return '0分钟';
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
      if (hours > 0) return `${hours}h`;
      return `${minutes}分钟`;
    }
  };
});
