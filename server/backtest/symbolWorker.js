'use strict';
/**
 * symbolWorker.js — Per-symbol worker thread entry point
 *
 * Spawned by worker.js (one per symbol) when parallelSymbols is enabled.
 * Runs a single-symbol backtest via runBacktestSymbolMTF and posts results back.
 */

const { workerData, parentPort } = require('worker_threads');
const { runBacktestSymbolMTF }   = require('./engine.js');

// Forward any unhandled rejections to the parent worker
process.on('unhandledRejection', (reason) => {
  console.error(`[SymbolWorker] unhandledRejection in ${workerData?.symbol}: ${reason}`);
  try { parentPort.postMessage({ type: 'error', symbol: workerData?.symbol, message: String(reason) }); } catch {}
  process.exit(1);
});

const { symbol, config } = workerData;

runBacktestSymbolMTF(symbol, config)
  .then(({ trades, equityMap, totalBarsProcessed }) => {
    parentPort.postMessage({ type: 'complete', symbol, trades, equityMap, totalBarsProcessed });
  })
  .catch(err => {
    console.error(`[SymbolWorker] ${symbol} error: ${err.message}\n${err.stack}`);
    parentPort.postMessage({ type: 'error', symbol, message: err.message });
  });
