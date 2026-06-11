export const defaultTrendSettings = {
  whiteOverheatPct: 30,
  nearYellowPct: 3,
  enableWhiteBelowYellowAlert: true,
  enableTrendDisplay: true,
};

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

export function calculateEma(values, period) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = clean[0];
  for (let index = 1; index < clean.length; index += 1) {
    ema = alpha * clean[index] + (1 - alpha) * ema;
  }
  return ema;
}

export function calculateMa(values, period) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length < period) return null;
  const slice = clean.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function calculateZhixingShortLine(closePrices) {
  const clean = closePrices.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length < 20) return null;
  const alpha = 2 / (10 + 1);
  const firstEma = [];
  let ema = clean[0];
  firstEma.push(ema);
  for (let index = 1; index < clean.length; index += 1) {
    ema = alpha * clean[index] + (1 - alpha) * ema;
    firstEma.push(ema);
  }
  return calculateEma(firstEma, 10);
}

export function calculateZhixingLongLine(closePrices) {
  const clean = closePrices.map(Number).filter((value) => Number.isFinite(value));
  if (clean.length < 114) return null;
  const ma14 = calculateMa(clean, 14);
  const ma28 = calculateMa(clean, 28);
  const ma57 = calculateMa(clean, 57);
  const ma114 = calculateMa(clean, 114);
  if ([ma14, ma28, ma57, ma114].some((value) => value === null)) return null;
  return (ma14 + ma28 + ma57 + ma114) / 4;
}

export function calculateTrendStatus(currentPrice, whiteLine, yellowLine, settings = {}) {
  const merged = { ...defaultTrendSettings, ...settings };
  if (!currentPrice || !whiteLine || !yellowLine) {
    return {
      status: '历史数据不足',
      whiteDeviationPct: null,
      yellowDeviationPct: null,
      alerts: [{ level: 'info', type: 'insufficient_history', message: '历史数据不足，无法计算知行趋势线。' }],
    };
  }

  const whiteDeviationPct = ((currentPrice - whiteLine) / whiteLine) * 100;
  const yellowDeviationPct = ((currentPrice - yellowLine) / yellowLine) * 100;
  const yellowDistancePct = Math.abs(yellowDeviationPct);
  let status = '接近多空线';
  if (currentPrice > whiteLine && whiteLine > yellowLine) status = '强势多头';
  else if (currentPrice > yellowLine && currentPrice < whiteLine) status = '趋势未破但短线转弱';
  else if (currentPrice < yellowLine) status = '跌破多空线';

  const alerts = [];
  if (whiteDeviationPct >= Number(merged.whiteOverheatPct || 30)) {
    alerts.push({ level: 'warning', type: 'white_overheat', message: '当前股价远超短期趋势线，注意高位波动和回撤风险。' });
  }
  if (yellowDistancePct <= Number(merged.nearYellowPct || 3)) {
    alerts.push({ level: 'warning', type: 'near_yellow', message: '当前股价接近知行多空线，需要关注是否跌破中期趋势。' });
  }
  if (currentPrice < yellowLine) {
    alerts.push({ level: 'danger', type: 'below_yellow', message: '当前股价已跌破知行多空线，需按风控规则检查是否减仓或止损。' });
  }
  if (merged.enableWhiteBelowYellowAlert !== false && whiteLine < yellowLine) {
    alerts.push({ level: 'warning', type: 'white_below_yellow', message: '短期趋势线已跌破多空线，趋势结构转弱。' });
  }
  if (currentPrice > whiteLine && whiteLine > yellowLine) {
    alerts.push({ level: 'success', type: 'bullish_alignment', message: '股价、白线、黄线呈多头排列。' });
  }

  return {
    status,
    whiteDeviationPct: round(whiteDeviationPct),
    yellowDeviationPct: round(yellowDeviationPct),
    alerts,
  };
}

export function calculateZhixingTrend(closePrices, currentPrice, settings = {}) {
  const whiteLine = calculateZhixingShortLine(closePrices);
  const yellowLine = calculateZhixingLongLine(closePrices);
  const trend = calculateTrendStatus(Number(currentPrice), whiteLine, yellowLine, settings);
  return {
    whiteLine: round(whiteLine),
    yellowLine: round(yellowLine),
    whiteDeviationPct: trend.whiteDeviationPct,
    yellowDeviationPct: trend.yellowDeviationPct,
    trendStatus: trend.status,
    trendAlerts: trend.alerts,
    historyCount: closePrices.length,
    historyInsufficient: closePrices.length < 114,
  };
}
