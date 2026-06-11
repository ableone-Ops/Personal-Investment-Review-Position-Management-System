import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TDX_INDEXES, updateIndicesFromTdx, updateQuotesFromTdx } from './tdxData.js';
import { calculateZhixingTrend } from './trendIndicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemPython = 'C:\\Users\\Huzhiwei\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
const bundledPython = 'C:\\Users\\Huzhiwei\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
const pythonExecutable = process.env.FUPAN_PYTHON || (fs.existsSync(systemPython) ? systemPython : bundledPython);

function normalizeCode(code) {
  return String(code || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
}

function runAkshareProvider(codes) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'akshare_provider.py');
    const child = spawn(pythonExecutable, [script, JSON.stringify({ codes })], {
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new Error(`无法启动 Python 行情进程：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `行情进程退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`行情返回解析失败：${error.message}; ${stderr}`));
      }
    });
  });
}

function normalizeAkshareStock(item) {
  return {
    ...item,
    code: normalizeCode(item.code),
    source: 'akshare',
    tradeDate: item.tradeDate || new Date().toISOString().slice(0, 10),
    isLatest: true,
  };
}

function akshareIndexCodeToDb(code) {
  const clean = normalizeCode(code);
  return clean.startsWith('399') ? `${clean}.SZ` : `${clean}.SH`;
}

function normalizeAkshareIndex(item) {
  const indexCode = item.indexCode || akshareIndexCodeToDb(item.code);
  const mapped = TDX_INDEXES.find((index) => index.indexCode === indexCode);
  return {
    ...item,
    indexCode,
    code: indexCode,
    name: mapped?.name || item.name || indexCode,
    source: 'akshare',
    tradeDate: item.tradeDate || new Date().toISOString().slice(0, 10),
    isLatest: true,
  };
}

function removeResolvedFailures(failures, successCodes, key = 'code') {
  return failures.filter((item) => !successCodes.has(item[key] || item.code || item.indexCode));
}

function dedupeFailures(failures, keyGetter) {
  const map = new Map();
  for (const item of failures) map.set(keyGetter(item), item);
  return [...map.values()];
}

export async function updateMarketData(codes, settings = {}) {
  const cleanCodes = [...new Set(codes.map(normalizeCode).filter(Boolean))];
  const useTdx = settings.preferTdxLocal !== false;
  const fallbackAkshare = settings.fallbackAkshare !== false;
  const updatedAt = new Date().toISOString();
  const tradeDate = new Date().toISOString().slice(0, 10);
  const stocks = [];
  const indexes = [];
  let stockFailures = [];
  let indexFailures = [];
  let pendingStocks = [...cleanCodes];
  let pendingIndexes = TDX_INDEXES.map((item) => item.indexCode);

  if (useTdx) {
    const stockResult = updateQuotesFromTdx(pendingStocks, settings);
    stocks.push(...stockResult.stocks.map((stock) => ({
      ...stock,
      trend: calculateZhixingTrend((stock.historyRecords || []).map((record) => record.close), stock.price, settings.trendSettings || settings),
    })));
    const stockSuccessCodes = new Set(stockResult.stocks.map((item) => normalizeCode(item.code)));
    pendingStocks = pendingStocks.filter((code) => !stockSuccessCodes.has(code));
    stockFailures.push(...stockResult.stockFailures.map((item) => ({ ...item, stage: 'primary' })));

    const indexResult = updateIndicesFromTdx(settings);
    indexes.push(...indexResult.indexes);
    const indexSuccessCodes = new Set(indexResult.indexes.map((item) => item.indexCode));
    pendingIndexes = pendingIndexes.filter((code) => !indexSuccessCodes.has(code));
    indexFailures.push(...indexResult.indexFailures.map((item) => ({ ...item, stage: 'primary' })));
  }

  if (fallbackAkshare && (pendingStocks.length > 0 || pendingIndexes.length > 0)) {
    try {
      const akResult = await runAkshareProvider(pendingStocks);
      const akStocks = (akResult.stocks || []).map(normalizeAkshareStock);
      stocks.push(...akStocks);
      const akStockSuccessCodes = new Set(akStocks.map((item) => normalizeCode(item.code)));
      pendingStocks = pendingStocks.filter((code) => !akStockSuccessCodes.has(code));
      stockFailures = removeResolvedFailures(stockFailures, akStockSuccessCodes, 'code');

      const akIndexes = (akResult.indexes || []).map(normalizeAkshareIndex).filter((item) => pendingIndexes.includes(item.indexCode));
      indexes.push(...akIndexes);
      const akIndexSuccessCodes = new Set(akIndexes.map((item) => item.indexCode));
      pendingIndexes = pendingIndexes.filter((code) => !akIndexSuccessCodes.has(code));
      indexFailures = removeResolvedFailures(indexFailures, akIndexSuccessCodes, 'indexCode');

      stockFailures.push(...(akResult.stockFailures || [])
        .filter((item) => pendingStocks.includes(normalizeCode(item.code)))
        .map((item) => ({ ...item, source: 'akshare', stage: 'fallback' })));
      indexFailures.push(...(akResult.indexFailures || [])
        .map((item) => ({ ...item, indexCode: normalizeAkshareIndex(item).indexCode, source: 'akshare', stage: 'fallback' }))
        .filter((item) => pendingIndexes.includes(item.indexCode)));
    } catch (error) {
      stockFailures.push(...pendingStocks.map((code) => ({ code, source: 'akshare', stage: 'fallback', reason: error.message })));
      indexFailures.push(...pendingIndexes.map((indexCode) => {
        const mapped = TDX_INDEXES.find((item) => item.indexCode === indexCode);
        return { code: indexCode, indexCode, name: mapped?.name || indexCode, source: 'akshare', stage: 'fallback', reason: error.message };
      }));
    }
  }

  const quoteDates = [...stocks, ...indexes].map((item) => item.tradeDate).filter(Boolean).sort();
  const effectiveTradeDate = quoteDates.at(-1) || tradeDate;

  return {
    ok: pendingStocks.length === 0 && pendingIndexes.length === 0,
    tradeDate: effectiveTradeDate,
    updatedAt,
    stocks,
    indexes,
    stockFailures: dedupeFailures(stockFailures, (item) => normalizeCode(item.code)),
    indexFailures: dedupeFailures(indexFailures, (item) => item.indexCode || item.code),
  };
}
