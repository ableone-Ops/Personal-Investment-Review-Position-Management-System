import fs from 'node:fs';
import path from 'node:path';

const DAY_RECORD_SIZE = 32;

export const TDX_INDEXES = [
  { indexCode: '000001.SH', tdxCode: 'sh000001', name: '上证指数' },
  { indexCode: '399001.SZ', tdxCode: 'sz399001', name: '深证成指' },
  { indexCode: '399006.SZ', tdxCode: 'sz399006', name: '创业板指' },
  { indexCode: '000688.SH', tdxCode: 'sh000688', name: '科创50' },
  { indexCode: '000300.SH', tdxCode: 'sh000300', name: '沪深300' },
  { indexCode: '000905.SH', tdxCode: 'sh000905', name: '中证500' },
];

function normalizeCode(code) {
  return String(code || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
}

function formatDate(value) {
  const text = String(value || '');
  if (text.length !== 8) return '';
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function latestWeekday(date = new Date()) {
  const next = new Date(date);
  const day = next.getDay();
  if (day === 0) next.setDate(next.getDate() - 2);
  if (day === 6) next.setDate(next.getDate() - 1);
  return next.toISOString().slice(0, 10);
}

function readTdxRecord(buffer, offset) {
  const dateRaw = buffer.readInt32LE(offset);
  const open = buffer.readInt32LE(offset + 4) / 100;
  const high = buffer.readInt32LE(offset + 8) / 100;
  const low = buffer.readInt32LE(offset + 12) / 100;
  const close = buffer.readInt32LE(offset + 16) / 100;
  const amount = Number(buffer.readFloatLE(offset + 20).toFixed(2));
  const volume = buffer.readInt32LE(offset + 24);
  return {
    tradeDate: formatDate(dateRaw),
    open,
    high,
    low,
    close,
    price: close,
    volume,
    turnover: amount,
    amount,
  };
}

export function getMarketByCode(code) {
  const clean = normalizeCode(code);
  if (clean.startsWith('6') || clean.startsWith('688')) return 'sh';
  if (clean.startsWith('0') || clean.startsWith('3')) return 'sz';
  if (clean.startsWith('8') || clean.startsWith('4')) return 'bj';
  return '';
}

export function getTdxDayFilePath(code, tdxPath) {
  const clean = normalizeCode(code);
  const market = getMarketByCode(clean);
  if (market === 'bj') throw new Error('北交所代码暂不支持读取通达信本地日线');
  if (!market) throw new Error('无法根据股票代码判断沪深市场');
  return path.join(tdxPath, 'vipdoc', market, 'lday', `${market}${clean}.day`);
}

export function readTdxDayFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < DAY_RECORD_SIZE) throw new Error('文件内容不足 32 字节，无法解析日线');
  if (buffer.length % DAY_RECORD_SIZE !== 0) throw new Error(`文件长度 ${buffer.length} 不是 32 字节记录的整数倍`);

  const offset = buffer.length - DAY_RECORD_SIZE;
  const latest = readTdxRecord(buffer, offset);
  const previousOffset = buffer.length >= DAY_RECORD_SIZE * 2 ? buffer.length - DAY_RECORD_SIZE * 2 : null;
  const previous = previousOffset === null ? null : readTdxRecord(buffer, previousOffset);
  const changePct = previous?.close > 0 ? Number((((latest.close - previous.close) / previous.close) * 100).toFixed(2)) : null;

  if (!latest.tradeDate || !latest.close) throw new Error('最新记录缺少有效日期或收盘价');
  return {
    ...latest,
    changePct,
    previousClose: previous?.close ?? null,
    historyInsufficient: !previous,
    source: 'tdx_local',
    filePath,
  };
}

export function getTdxStockQuote(code, tdxPath) {
  const clean = normalizeCode(code);
  const filePath = getTdxDayFilePath(clean, tdxPath);
  const quote = readTdxDayFile(filePath);
  const expectedDate = latestWeekday();
  return {
    code: clean,
    ...quote,
    isLatest: quote.tradeDate >= expectedDate,
    expectedDate,
  };
}

export function getTdxIndexQuote(index, tdxPath) {
  const market = index.tdxCode.slice(0, 2);
  const filePath = path.join(tdxPath, 'vipdoc', market, 'lday', `${index.tdxCode}.day`);
  const quote = readTdxDayFile(filePath);
  const expectedDate = latestWeekday();
  return {
    indexCode: index.indexCode,
    code: index.indexCode,
    name: index.name,
    tdxCode: index.tdxCode,
    ...quote,
    isLatest: quote.tradeDate >= expectedDate,
    expectedDate,
  };
}

export function updateQuotesFromTdx(codes, settings) {
  const tdxPath = settings?.tdxPath || 'D:\\HTZQ';
  const stocks = [];
  const stockFailures = [];
  for (const code of codes) {
    try {
      stocks.push(getTdxStockQuote(code, tdxPath));
    } catch (error) {
      stockFailures.push({ code: normalizeCode(code), source: 'tdx_local', reason: error.message });
    }
  }
  return { stocks, stockFailures };
}

export function updateIndicesFromTdx(settings) {
  const tdxPath = settings?.tdxPath || 'D:\\HTZQ';
  const indexes = [];
  const indexFailures = [];
  for (const index of TDX_INDEXES) {
    try {
      indexes.push(getTdxIndexQuote(index, tdxPath));
    } catch (error) {
      indexFailures.push({ code: index.indexCode, indexCode: index.indexCode, name: index.name, source: 'tdx_local', reason: error.message });
    }
  }
  return { indexes, indexFailures };
}

export function detectTdxDataDirectory(tdxPath = 'D:\\HTZQ') {
  const checks = [
    { key: 'root', label: tdxPath, path: tdxPath },
    { key: 'vipdoc', label: 'vipdoc', path: path.join(tdxPath, 'vipdoc') },
    { key: 'shLday', label: '沪市日线目录', path: path.join(tdxPath, 'vipdoc', 'sh', 'lday') },
    { key: 'szLday', label: '深市日线目录', path: path.join(tdxPath, 'vipdoc', 'sz', 'lday') },
  ].map((item) => ({ ...item, exists: fs.existsSync(item.path) }));

  const errors = checks.filter((item) => !item.exists).map((item) => `${item.label} 不存在：${item.path}`);
  const sampleDirs = checks.filter((item) => item.key === 'shLday' || item.key === 'szLday').map((item) => item.path);
  let sample = null;
  for (const dir of sampleDirs) {
    if (!fs.existsSync(dir)) continue;
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.day'));
    if (!file) continue;
    try {
      sample = readTdxDayFile(path.join(dir, file));
      break;
    } catch (error) {
      errors.push(`${file} 读取失败：${error.message}`);
    }
  }
  if (!sample && errors.length === 0) errors.push('未找到可读取的 .day 文件');
  const expectedDate = latestWeekday();
  if (sample && sample.tradeDate < expectedDate) errors.push(`最近一条数据日期 ${sample.tradeDate} 早于参考交易日 ${expectedDate}`);

  return {
    ok: errors.length === 0,
    tdxPath,
    checks,
    canReadDayFile: Boolean(sample),
    latestTradeDate: sample?.tradeDate || '',
    expectedDate,
    isLatest: sample ? sample.tradeDate >= expectedDate : false,
    sample,
    errors,
  };
}
