// London wall-clock time (BST/GMT via Intl) and the time-of-day car count from sim/config.json timeOfDay.
const FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });

export function londonClock(now = new Date()) {
  const parts = Object.fromEntries(FORMAT.formatToParts(now).map(p => [p.type, p.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), day: parts.weekday, weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun' };
}

export const hhmm = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toMinutes = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };

// Night count from nightFrom to nightTo, day count from dayFrom to dayTo, linear ramps in between.
export function targetCars(minutes, weekend, demand, config) {
  const nightTo = toMinutes(config.nightTo), dayFrom = toMinutes(config.dayFrom), dayTo = toMinutes(config.dayTo), nightFrom = toMinutes(config.nightFrom);
  const m = ((minutes % 1440) + 1440) % 1440, { night, day } = config;
  const base = m < nightTo || m >= nightFrom ? night
    : m < dayFrom ? night + (day - night) * (m - nightTo) / (dayFrom - nightTo)
    : m < dayTo ? day
    : day + (night - day) * (m - dayTo) / (nightFrom - dayTo);
  return base * (weekend ? config.weekendFactor : 1) * demand;
}
