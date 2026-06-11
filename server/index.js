import { createServer } from 'node:http';
import { parse } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { updateMarketData } from './marketData.js';
import { detectTdxDataDirectory } from './tdxData.js';
import { defaultTrendSettings } from './trendIndicators.js';

const PORT = Number(process.env.PORT || 3100);
const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'fupan.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const defaultRules = {
  account: {
    maxPositionRatio: 80,
    minCashRatio: 20,
    maxDrawdown: 15,
    annualProfitProtectLine: 0,
    initialEquity: 100000,
    cash: 50000,
    yearStartEquity: 100000,
    historicalHighEquity: 100000,
  },
  stock: { maxSinglePositionRatio: 20 },
  industry: { maxIndustryPositionRatio: 35 },
};

const defaultMarketSettings = {
  tdxPath: 'D:\\HTZQ',
  preferTdxLocal: true,
  fallbackAkshare: true,
  trendSettings: defaultTrendSettings,
};

const defaultIndexes = [
  ['000001.SH', '上证指数'],
  ['399001.SZ', '深证成指'],
  ['399006.SZ', '创业板指'],
  ['000688.SH', '科创50'],
  ['000300.SH', '沪深300'],
  ['000905.SH', '中证500'],
];

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  holding_type TEXT NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  current_price REAL NOT NULL DEFAULT 0,
  stop_loss_price REAL,
  take_profit_price REAL,
  reduce_below_price REAL,
  reduce_ratio REAL,
  observe_above_price REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS index_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date TEXT NOT NULL,
  index_code TEXT NOT NULL,
  index_name TEXT NOT NULL,
  close_point REAL NOT NULL DEFAULT 0,
  change_pct REAL NOT NULL DEFAULT 0,
  turnover REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(trade_date, index_code)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_date TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  judgement TEXT DEFAULT '',
  tomorrow_plan TEXT DEFAULT '',
  emotion TEXT DEFAULT '',
  discipline_followed INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function ensureColumn(table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('positions', 'change_pct', 'change_pct REAL');
ensureColumn('positions', 'volume', 'volume REAL');
ensureColumn('positions', 'turnover', 'turnover REAL');
ensureColumn('positions', 'quote_date', 'quote_date TEXT');
ensureColumn('positions', 'quote_updated_at', 'quote_updated_at TEXT');
ensureColumn('positions', 'quote_source', 'quote_source TEXT DEFAULT "manual"');
ensureColumn('positions', 'quote_is_latest', 'quote_is_latest INTEGER DEFAULT 0');
ensureColumn('positions', 'white_line', 'white_line REAL');
ensureColumn('positions', 'yellow_line', 'yellow_line REAL');
ensureColumn('positions', 'white_deviation_pct', 'white_deviation_pct REAL');
ensureColumn('positions', 'yellow_deviation_pct', 'yellow_deviation_pct REAL');
ensureColumn('positions', 'trend_status', 'trend_status TEXT');
ensureColumn('positions', 'trend_history_count', 'trend_history_count INTEGER DEFAULT 0');
ensureColumn('positions', 'trend_alerts', 'trend_alerts TEXT');
ensureColumn('index_records', 'open_point', 'open_point REAL');
ensureColumn('index_records', 'high_point', 'high_point REAL');
ensureColumn('index_records', 'low_point', 'low_point REAL');
ensureColumn('index_records', 'volume', 'volume REAL');
ensureColumn('index_records', 'quote_source', 'quote_source TEXT DEFAULT "manual"');
ensureColumn('index_records', 'quote_updated_at', 'quote_updated_at TEXT');

function jsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? jsonParse(row.value, fallback) : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('rules')) setSetting('rules', defaultRules);
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('marketSettings')) setSetting('marketSettings', defaultMarketSettings);

function getMarketSettings() {
  const stored = getSetting('marketSettings', defaultMarketSettings);
  return { ...defaultMarketSettings, ...stored, trendSettings: { ...defaultTrendSettings, ...(stored.trendSettings || {}) } };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function normalizeCode(code) {
  return String(code || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
}

function normalizePosition(row, totalEquity = 0) {
  const marketValue = Number(row.current_price || 0) * Number(row.quantity || 0);
  const costValue = Number(row.cost_price || 0) * Number(row.quantity || 0);
  const profit = marketValue - costValue;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    market: row.market || '',
    industry: row.industry || '',
    holdingType: row.holding_type,
    costPrice: Number(row.cost_price || 0),
    quantity: Number(row.quantity || 0),
    currentPrice: Number(row.current_price || 0),
    changePct: row.change_pct === null ? null : Number(row.change_pct || 0),
    volume: row.volume === null ? null : Number(row.volume || 0),
    turnover: row.turnover === null ? null : Number(row.turnover || 0),
    quoteDate: row.quote_date || '',
    quoteUpdatedAt: row.quote_updated_at || '',
    quoteSource: row.quote_source || 'manual',
    quoteIsLatest: Boolean(row.quote_is_latest),
    whiteLine: row.white_line === null ? null : Number(row.white_line || 0),
    yellowLine: row.yellow_line === null ? null : Number(row.yellow_line || 0),
    whiteDeviationPct: row.white_deviation_pct === null ? null : Number(row.white_deviation_pct || 0),
    yellowDeviationPct: row.yellow_deviation_pct === null ? null : Number(row.yellow_deviation_pct || 0),
    trendStatus: row.trend_status || '',
    trendHistoryCount: Number(row.trend_history_count || 0),
    trendAlerts: jsonParse(row.trend_alerts, []),
    stopLossPrice: row.stop_loss_price,
    takeProfitPrice: row.take_profit_price,
    reduceBelowPrice: row.reduce_below_price,
    reduceRatio: row.reduce_ratio,
    observeAbovePrice: row.observe_above_price,
    marketValue: round(marketValue),
    profit: round(profit),
    profitPct: costValue > 0 ? round((profit / costValue) * 100) : 0,
    positionRatio: totalEquity > 0 ? round((marketValue / totalEquity) * 100) : 0,
  };
}

function getPositions() {
  return db.prepare('SELECT * FROM positions ORDER BY id DESC').all();
}

function computeSnapshot() {
  const rules = getSetting('rules', defaultRules);
  const marketSettings = getMarketSettings();
  const rawPositions = getPositions();
  const holdingValue = rawPositions.reduce((sum, item) => sum + Number(item.current_price || 0) * Number(item.quantity || 0), 0);
  const cash = Number(rules.account.cash || 0);
  const totalEquity = cash + holdingValue;
  const positions = rawPositions.map((item) => normalizePosition(item, totalEquity));
  const positionRatio = totalEquity > 0 ? (holdingValue / totalEquity) * 100 : 0;
  const yearStartEquity = Number(rules.account.yearStartEquity || totalEquity || 1);
  const historicalHighEquity = Math.max(Number(rules.account.historicalHighEquity || 0), totalEquity);
  if (historicalHighEquity !== Number(rules.account.historicalHighEquity || 0)) {
    rules.account.historicalHighEquity = historicalHighEquity;
    setSetting('rules', rules);
  }
  const drawdown = historicalHighEquity > 0 ? ((historicalHighEquity - totalEquity) / historicalHighEquity) * 100 : 0;
  const yearReturn = yearStartEquity > 0 ? ((totalEquity - yearStartEquity) / yearStartEquity) * 100 : 0;
  const cashRatio = totalEquity > 0 ? (cash / totalEquity) * 100 : 0;
  const alerts = evaluateAlerts({ rules, marketSettings, positions, totalEquity, cash, positionRatio, drawdown, yearReturn });
  return {
    account: {
      totalEquity: round(totalEquity),
      cash: round(cash),
      cashRatio: round(cashRatio),
      holdingValue: round(holdingValue),
      positionRatio: round(positionRatio),
      yearReturn: round(yearReturn),
      historicalHighEquity: round(historicalHighEquity),
      drawdown: round(drawdown),
      riskStatus: deriveRiskStatus(alerts),
    },
    positions,
    rules,
    marketSettings,
    alerts,
  };
}

function evaluateAlerts({ rules, marketSettings, positions, totalEquity, cash, positionRatio, drawdown, yearReturn }) {
  const alerts = [];
  const account = rules.account;
  if (positionRatio > Number(account.maxPositionRatio || 100)) alerts.push({ level: 'danger', scope: '账户', message: `总仓位 ${round(positionRatio)}% 超过上限 ${account.maxPositionRatio}%` });
  const cashRatio = totalEquity > 0 ? (cash / totalEquity) * 100 : 0;
  if (cashRatio < Number(account.minCashRatio || 0)) alerts.push({ level: 'warning', scope: '账户', message: `现金比例 ${round(cashRatio)}% 低于最低要求 ${account.minCashRatio}%` });
  if (drawdown > Number(account.maxDrawdown || 100)) alerts.push({ level: 'danger', scope: '账户', message: `当前回撤 ${round(drawdown)}% 超过最大回撤 ${account.maxDrawdown}%` });
  if (yearReturn < Number(account.annualProfitProtectLine || -100)) alerts.push({ level: 'warning', scope: '账户', message: `今年收益率 ${round(yearReturn)}% 低于年度保护线 ${account.annualProfitProtectLine}%` });

  const maxSingle = Number(rules.stock.maxSinglePositionRatio || 100);
  positions.forEach((position) => {
    if (position.positionRatio > maxSingle) alerts.push({ level: 'danger', scope: position.name, message: `${position.name} 仓位 ${position.positionRatio}% 超过单股上限 ${maxSingle}%` });
    if (position.stopLossPrice && position.currentPrice <= position.stopLossPrice) alerts.push({ level: 'danger', scope: position.name, message: `${position.name} 当前价跌破止损价 ${position.stopLossPrice}` });
    if (position.takeProfitPrice && position.currentPrice >= position.takeProfitPrice) alerts.push({ level: 'success', scope: position.name, message: `${position.name} 当前价达到止盈价 ${position.takeProfitPrice}` });
    if (position.reduceBelowPrice && position.currentPrice <= position.reduceBelowPrice) alerts.push({ level: 'warning', scope: position.name, message: `${position.name} 跌破 ${position.reduceBelowPrice}，建议减仓 ${position.reduceRatio || 0}%` });
    if (position.observeAbovePrice && position.currentPrice >= position.observeAbovePrice) alerts.push({ level: 'info', scope: position.name, message: `${position.name} 突破 ${position.observeAbovePrice}，进入观察` });
    if (marketSettings?.trendSettings?.enableTrendDisplay !== false) {
      (position.trendAlerts || []).forEach((trendAlert) => {
        if (trendAlert.type === 'insufficient_history') return;
        alerts.push({ level: trendAlert.level || 'info', scope: position.name, message: `${position.name}：${trendAlert.message}` });
      });
    }
  });

  const byIndustry = new Map();
  positions.forEach((position) => {
    const industry = position.industry || '未分类';
    byIndustry.set(industry, (byIndustry.get(industry) || 0) + position.marketValue);
  });
  const maxIndustry = Number(rules.industry.maxIndustryPositionRatio || 100);
  for (const [industry, value] of byIndustry.entries()) {
    const ratio = totalEquity > 0 ? (value / totalEquity) * 100 : 0;
    if (ratio > maxIndustry) alerts.push({ level: 'warning', scope: industry, message: `${industry} 行业仓位 ${round(ratio)}% 超过上限 ${maxIndustry}%` });
  }
  return alerts;
}

function deriveRiskStatus(alerts) {
  if (alerts.some((item) => item.level === 'danger')) return '危险';
  if (alerts.filter((item) => item.level === 'warning').length >= 2) return '防守';
  if (alerts.length > 0) return '观察';
  return '正常';
}

function getIndexes() {
  return db.prepare('SELECT * FROM index_records ORDER BY trade_date DESC, index_code ASC').all().map((row) => ({
    id: row.id,
    tradeDate: row.trade_date,
    indexCode: row.index_code,
    indexName: row.index_name,
    openPoint: row.open_point === null ? null : Number(row.open_point || 0),
    highPoint: row.high_point === null ? null : Number(row.high_point || 0),
    lowPoint: row.low_point === null ? null : Number(row.low_point || 0),
    closePoint: Number(row.close_point || 0),
    changePct: Number(row.change_pct || 0),
    volume: row.volume === null ? null : Number(row.volume || 0),
    turnover: Number(row.turnover || 0),
    quoteSource: row.quote_source || 'manual',
    quoteUpdatedAt: row.quote_updated_at || '',
  }));
}

function marketStates() {
  return defaultIndexes.map(([code, name]) => {
    const rows = db.prepare('SELECT * FROM index_records WHERE index_code = ? ORDER BY trade_date DESC LIMIT 120').all(code).reverse();
    if (rows.length === 0) return { indexCode: code, indexName: name, state: '待记录', closePoint: 0, ma20: null, ma60: null, aboveMa20: false, aboveMa60: false, debug: { historyCount: 0, ma20Count: 0, ma60Count: 0, ma20: null, ma60: null } };
    const last = rows.at(-1);
    const ma20Rows = rows.slice(-20);
    const ma60Rows = rows.slice(-60);
    const ma20 = rows.length >= 20 ? ma20Rows.reduce((sum, row) => sum + Number(row.close_point || 0), 0) / 20 : null;
    const ma60 = rows.length >= 60 ? ma60Rows.reduce((sum, row) => sum + Number(row.close_point || 0), 0) / 60 : null;
    const closePoint = Number(last.close_point);
    const aboveMa20 = ma20 === null ? false : closePoint >= ma20;
    const aboveMa60 = ma60 === null ? false : closePoint >= ma60;
    let state = rows.length < 20 ? '历史不足' : '正常';
    if (ma60 !== null && !aboveMa60) state = '防守';
    else if (ma20 !== null && !aboveMa20) state = '观察';
    return {
      indexCode: code,
      indexName: name,
      state,
      closePoint,
      ma20: ma20 === null ? null : round(ma20),
      ma60: ma60 === null ? null : round(ma60),
      aboveMa20,
      aboveMa60,
      tradeDate: last.trade_date,
      debug: { historyCount: rows.length, ma20Count: ma20Rows.length, ma60Count: ma60Rows.length, ma20: ma20 === null ? null : round(ma20), ma60: ma60 === null ? null : round(ma60) },
    };
  });
}

function buildReviewSnapshot(date = today()) {
  const snapshot = computeSnapshot();
  const indexRows = db.prepare('SELECT * FROM index_records WHERE trade_date = ? ORDER BY index_code').all(date);
  return {
    date,
    account: snapshot.account,
    positions: snapshot.positions.map((item) => ({
      code: item.code,
      name: item.name,
      currentPrice: item.currentPrice,
      changePct: item.changePct,
      volume: item.volume,
      turnover: item.turnover,
      quoteDate: item.quoteDate,
      quoteSource: item.quoteSource,
      quoteIsLatest: item.quoteIsLatest,
      whiteLine: item.whiteLine,
      yellowLine: item.yellowLine,
      whiteDeviationPct: item.whiteDeviationPct,
      yellowDeviationPct: item.yellowDeviationPct,
      trendStatus: item.trendStatus,
      trendAlerts: item.trendAlerts,
      marketValue: item.marketValue,
      profit: item.profit,
      profitPct: item.profitPct,
      positionRatio: item.positionRatio,
    })),
    alerts: snapshot.alerts,
    trendSummary: {
      whiteOverheat: snapshot.positions.filter((item) => (item.trendAlerts || []).some((alert) => alert.type === 'white_overheat')).map((item) => item.name),
      nearYellow: snapshot.positions.filter((item) => (item.trendAlerts || []).some((alert) => alert.type === 'near_yellow')).map((item) => item.name),
      belowYellow: snapshot.positions.filter((item) => (item.trendAlerts || []).some((alert) => alert.type === 'below_yellow')).map((item) => item.name),
      whiteBelowYellow: snapshot.positions.filter((item) => (item.trendAlerts || []).some((alert) => alert.type === 'white_below_yellow')).map((item) => item.name),
    },
    indexes: indexRows.map((row) => ({
      indexCode: row.index_code,
      indexName: row.index_name,
      openPoint: row.open_point === null ? null : Number(row.open_point || 0),
      highPoint: row.high_point === null ? null : Number(row.high_point || 0),
      lowPoint: row.low_point === null ? null : Number(row.low_point || 0),
      closePoint: Number(row.close_point),
      changePct: Number(row.change_pct),
      volume: row.volume === null ? null : Number(row.volume || 0),
      turnover: Number(row.turnover),
      quoteSource: row.quote_source || 'manual',
    })),
    marketStates: marketStates(),
    hotSectors: [],
  };
}

function upsertReviewSnapshot(date = today()) {
  const snapshot = buildReviewSnapshot(date);
  db.prepare(`
    INSERT INTO reviews (review_date, snapshot)
    VALUES (?, ?)
    ON CONFLICT(review_date) DO UPDATE SET snapshot=excluded.snapshot, updated_at=CURRENT_TIMESTAMP
  `).run(date, JSON.stringify(snapshot));
  return snapshot;
}

function providerIndexCodeToDb(code) {
  const clean = normalizeCode(code);
  return clean.startsWith('399') ? `${clean}.SZ` : `${clean}.SH`;
}

async function runMarketUpdate() {
  const positions = getPositions();
  const codes = positions.map((item) => normalizeCode(item.code)).filter(Boolean);
  const settings = getMarketSettings();
  const providerResult = await updateMarketData(codes, settings);
  const quoteTime = providerResult.updatedAt || new Date().toISOString();

  let stockSuccess = 0;
  const stockResults = [];
  const stockFailures = [...(providerResult.stockFailures || [])];
  const stockMap = new Map((providerResult.stocks || []).map((item) => [normalizeCode(item.code), item]));
  for (const position of positions) {
    const code = normalizeCode(position.code);
    const quote = stockMap.get(code);
    if (!quote || quote.price === null || Number.isNaN(Number(quote.price))) {
      if (!stockFailures.some((item) => normalizeCode(item.code) === code)) stockFailures.push({ code, source: 'manual', reason: '未返回有效最新价，请手动录入' });
      stockResults.push({ code, name: position.name, success: false, source: 'manual', isLatest: false, reason: stockFailures.find((item) => normalizeCode(item.code) === code)?.reason || '更新失败' });
      continue;
    }
    db.prepare(`
      UPDATE positions
      SET current_price = ?, change_pct = ?, volume = ?, turnover = ?, quote_date = ?, quote_updated_at = ?, quote_source = ?, quote_is_latest = ?,
          white_line = ?, yellow_line = ?, white_deviation_pct = ?, yellow_deviation_pct = ?, trend_status = ?, trend_history_count = ?, trend_alerts = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      Number(quote.price),
      quote.changePct ?? null,
      quote.volume ?? null,
      quote.turnover ?? null,
      quote.tradeDate || providerResult.tradeDate || today(),
      quoteTime,
      quote.source || 'akshare',
      quote.isLatest ? 1 : 0,
      quote.trend?.whiteLine ?? null,
      quote.trend?.yellowLine ?? null,
      quote.trend?.whiteDeviationPct ?? null,
      quote.trend?.yellowDeviationPct ?? null,
      quote.trend?.trendStatus ?? null,
      quote.trend?.historyCount ?? 0,
      JSON.stringify(quote.trend?.trendAlerts || []),
      position.id,
    );
    stockSuccess += 1;
    stockResults.push({ code, name: position.name, success: true, source: quote.source || 'akshare', tradeDate: quote.tradeDate || providerResult.tradeDate || today(), isLatest: Boolean(quote.isLatest), price: quote.price, changePct: quote.changePct, volume: quote.volume, turnover: quote.turnover, trend: quote.trend });
  }

  let indexSuccess = 0;
  const indexResults = [];
  const indexFailures = [...(providerResult.indexFailures || [])];
  for (const quote of providerResult.indexes || []) {
    if (quote.price === null || Number.isNaN(Number(quote.price))) {
      indexFailures.push({ code: quote.code, name: quote.name, reason: '未返回有效点位' });
      continue;
    }
    const dbCode = quote.indexCode || providerIndexCodeToDb(quote.code);
    const indexName = defaultIndexes.find(([code]) => code === dbCode)?.[1] || quote.name || dbCode;
    const historyRecords = quote.historyRecords?.length ? quote.historyRecords : [quote];
    historyRecords.forEach((record, recordIndex) => {
      const previous = recordIndex > 0 ? historyRecords[recordIndex - 1] : null;
      const recordChangePct = previous?.close > 0 ? Number((((record.close - previous.close) / previous.close) * 100).toFixed(2)) : (record.changePct ?? null);
      db.prepare(`
        INSERT INTO index_records (trade_date, index_code, index_name, open_point, high_point, low_point, close_point, change_pct, volume, turnover, quote_source, quote_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trade_date, index_code) DO UPDATE SET
          index_name=excluded.index_name,
          open_point=excluded.open_point,
          high_point=excluded.high_point,
          low_point=excluded.low_point,
          close_point=excluded.close_point,
          change_pct=excluded.change_pct,
          volume=excluded.volume,
          turnover=excluded.turnover,
          quote_source=excluded.quote_source,
          quote_updated_at=excluded.quote_updated_at
      `).run(record.tradeDate || quote.tradeDate || providerResult.tradeDate || today(), dbCode, indexName, record.open ?? null, record.high ?? null, record.low ?? null, Number(record.close ?? record.price), recordChangePct ?? 0, record.volume ?? null, record.turnover ?? 0, quote.source || 'akshare', quoteTime);
    });
    db.prepare(`
      INSERT INTO index_records (trade_date, index_code, index_name, open_point, high_point, low_point, close_point, change_pct, volume, turnover, quote_source, quote_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_date, index_code) DO UPDATE SET
        index_name=excluded.index_name,
        open_point=excluded.open_point,
        high_point=excluded.high_point,
        low_point=excluded.low_point,
        close_point=excluded.close_point,
        change_pct=excluded.change_pct,
        volume=excluded.volume,
        turnover=excluded.turnover,
        quote_source=excluded.quote_source,
        quote_updated_at=excluded.quote_updated_at
    `).run(quote.tradeDate || providerResult.tradeDate || today(), dbCode, indexName, quote.open ?? null, quote.high ?? null, quote.low ?? null, Number(quote.price), quote.changePct ?? 0, quote.volume ?? null, quote.turnover ?? 0, quote.source || 'akshare', quoteTime);
    indexSuccess += 1;
    indexResults.push({ code: dbCode, indexCode: dbCode, name: indexName, success: true, source: quote.source || 'akshare', tradeDate: quote.tradeDate || providerResult.tradeDate || today(), isLatest: Boolean(quote.isLatest), closePoint: quote.price, changePct: quote.changePct, volume: quote.volume, turnover: quote.turnover, historyCount: historyRecords.length });
  }

  const snapshot = upsertReviewSnapshot(providerResult.tradeDate || today());
  const dashboard = computeSnapshot();
  return {
    ok: stockFailures.length === 0 && indexFailures.length === 0,
    updatedAt: quoteTime,
    tradeDate: providerResult.tradeDate || today(),
    stock: { requested: codes.length, success: stockSuccess, failed: stockFailures.length, results: stockResults, failures: stockFailures },
    index: { requested: defaultIndexes.length, success: indexSuccess, failed: indexFailures.length, results: indexResults, failures: indexFailures },
    snapshot,
    dashboard,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`请求 JSON 解析失败：${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendCsv(res, filename, text) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Access-Control-Allow-Origin': '*' });
  res.end('\ufeff' + text);
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function positionParams(input) {
  const optionalNumber = (value) => (value === '' || value === undefined || value === null ? null : Number(value));
  return {
    code: normalizeCode(input.code),
    name: input.name,
    market: input.market || '',
    industry: input.industry || '',
    holdingType: input.holdingType || '观察仓',
    costPrice: Number(input.costPrice || 0),
    quantity: Number(input.quantity || 0),
    currentPrice: Number(input.currentPrice || 0),
    changePct: optionalNumber(input.changePct),
    volume: optionalNumber(input.volume),
    turnover: optionalNumber(input.turnover),
    stopLossPrice: optionalNumber(input.stopLossPrice),
    takeProfitPrice: optionalNumber(input.takeProfitPrice),
    reduceBelowPrice: optionalNumber(input.reduceBelowPrice),
    reduceRatio: optionalNumber(input.reduceRatio),
    observeAbovePrice: optionalNumber(input.observeAbovePrice),
  };
}

async function route(req, res) {
  const { pathname, query } = parse(req.url, true);
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (pathname === '/api/dashboard' && req.method === 'GET') return send(res, 200, computeSnapshot());
  if (pathname === '/api/market/update' && req.method === 'POST') return send(res, 200, await runMarketUpdate());
  if (pathname === '/api/market/settings' && req.method === 'GET') return send(res, 200, getMarketSettings());
  if (pathname === '/api/market/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    const current = getMarketSettings();
    const next = { ...defaultMarketSettings, ...current, ...body, trendSettings: { ...defaultTrendSettings, ...(current.trendSettings || {}), ...(body.trendSettings || {}) } };
    setSetting('marketSettings', next);
    return send(res, 200, next);
  }
  if (pathname === '/api/market/tdx-detect' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, detectTdxDataDirectory(body.tdxPath || getMarketSettings().tdxPath));
  }
  if (pathname === '/api/rules' && req.method === 'GET') return send(res, 200, getSetting('rules', defaultRules));
  if (pathname === '/api/rules' && req.method === 'PUT') {
    const body = await readBody(req);
    setSetting('rules', body);
    return send(res, 200, body);
  }
  if (pathname === '/api/positions' && req.method === 'GET') return send(res, 200, computeSnapshot().positions);
  if (pathname === '/api/positions' && req.method === 'POST') {
    const p = positionParams(await readBody(req));
    const result = db.prepare(`
      INSERT INTO positions (code, name, market, industry, holding_type, cost_price, quantity, current_price, change_pct, volume, turnover, quote_source, stop_loss_price, take_profit_price, reduce_below_price, reduce_ratio, observe_above_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
    `).run(p.code, p.name, p.market, p.industry, p.holdingType, p.costPrice, p.quantity, p.currentPrice, p.changePct, p.volume, p.turnover, p.stopLossPrice, p.takeProfitPrice, p.reduceBelowPrice, p.reduceRatio, p.observeAbovePrice);
    return send(res, 201, { id: result.lastInsertRowid });
  }
  const positionMatch = pathname.match(/^\/api\/positions\/(\d+)$/);
  if (positionMatch && req.method === 'PUT') {
    const p = positionParams(await readBody(req));
    db.prepare(`
      UPDATE positions SET code=?, name=?, market=?, industry=?, holding_type=?, cost_price=?, quantity=?, current_price=?, change_pct=?, volume=?, turnover=?, quote_source='manual', stop_loss_price=?, take_profit_price=?, reduce_below_price=?, reduce_ratio=?, observe_above_price=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(p.code, p.name, p.market, p.industry, p.holdingType, p.costPrice, p.quantity, p.currentPrice, p.changePct, p.volume, p.turnover, p.stopLossPrice, p.takeProfitPrice, p.reduceBelowPrice, p.reduceRatio, p.observeAbovePrice, Number(positionMatch[1]));
    return send(res, 200, { ok: true });
  }
  if (positionMatch && req.method === 'DELETE') {
    db.prepare('DELETE FROM positions WHERE id = ?').run(Number(positionMatch[1]));
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/indexes' && req.method === 'GET') return send(res, 200, { records: getIndexes(), states: marketStates(), indexOptions: defaultIndexes.map(([indexCode, indexName]) => ({ indexCode, indexName })) });
  if (pathname === '/api/indexes' && req.method === 'POST') {
    const body = await readBody(req);
    db.prepare(`
      INSERT INTO index_records (trade_date, index_code, index_name, close_point, change_pct, turnover)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_date, index_code) DO UPDATE SET index_name=excluded.index_name, close_point=excluded.close_point, change_pct=excluded.change_pct, turnover=excluded.turnover
    `).run(body.tradeDate, body.indexCode, body.indexName, Number(body.closePoint || 0), Number(body.changePct || 0), Number(body.turnover || 0));
    return send(res, 201, { ok: true });
  }
  if (pathname === '/api/reviews' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM reviews ORDER BY review_date DESC').all().map((row) => ({
      id: row.id,
      reviewDate: row.review_date,
      snapshot: jsonParse(row.snapshot, {}),
      judgement: row.judgement || '',
      tomorrowPlan: row.tomorrow_plan || '',
      emotion: row.emotion || '',
      disciplineFollowed: Boolean(row.discipline_followed),
    }));
    return send(res, 200, rows);
  }
  if (pathname === '/api/reviews/generate' && req.method === 'POST') {
    const body = await readBody(req);
    const date = body.reviewDate || today();
    const snapshot = upsertReviewSnapshot(date);
    return send(res, 201, { reviewDate: date, snapshot });
  }
  const reviewMatch = pathname.match(/^\/api\/reviews\/(\d+)$/);
  if (reviewMatch && req.method === 'PUT') {
    const body = await readBody(req);
    db.prepare('UPDATE reviews SET judgement=?, tomorrow_plan=?, emotion=?, discipline_followed=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(body.judgement || '', body.tomorrowPlan || '', body.emotion || '', body.disciplineFollowed ? 1 : 0, Number(reviewMatch[1]));
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/export/positions' && req.method === 'GET') {
    const snapshot = computeSnapshot();
    const header = ['代码', '名称', '市场', '行业', '类型', '成本价', '数量', '当前价', '白线', '黄线', '白线偏离', '黄线偏离', '趋势状态', '涨跌幅', '成交量', '成交额', '行情日期', '数据来源', '是否最新', '更新时间', '市值', '浮盈亏', '收益率', '仓位'];
    const rows = snapshot.positions.map((p) => [p.code, p.name, p.market, p.industry, p.holdingType, p.costPrice, p.quantity, p.currentPrice, p.whiteLine ?? '', p.yellowLine ?? '', `${p.whiteDeviationPct ?? ''}%`, `${p.yellowDeviationPct ?? ''}%`, p.trendStatus, `${p.changePct ?? ''}%`, p.volume ?? '', p.turnover ?? '', p.quoteDate, p.quoteSource, p.quoteIsLatest ? '是' : '否', p.quoteUpdatedAt, p.marketValue, p.profit, `${p.profitPct}%`, `${p.positionRatio}%`]);
    return sendCsv(res, 'positions.csv', [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n'));
  }
  if (pathname === '/api/export/reviews' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM reviews ORDER BY review_date DESC').all();
    const header = ['日期', '总资产', '仓位', '风险状态', '今日判断', '明日计划', '情绪', '遵守纪律'];
    const data = rows.map((row) => {
      const snapshot = jsonParse(row.snapshot, {});
      return [row.review_date, snapshot.account?.totalEquity, `${snapshot.account?.positionRatio || 0}%`, snapshot.account?.riskStatus, row.judgement, row.tomorrow_plan, row.emotion, row.discipline_followed ? '是' : '否'];
    });
    return sendCsv(res, 'reviews.csv', [header, ...data].map((row) => row.map(csvCell).join(',')).join('\n'));
  }
  return send(res, 404, { error: 'Not found', path: pathname, query });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    send(res, 500, { error: error.message });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`API server listening on http://127.0.0.1:${PORT}`);
});
