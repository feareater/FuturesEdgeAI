'use strict';
/**
 * worker.js — Backtest worker thread entry point
 *
 * Runs runBacktestMTF in a dedicated thread so the main Express event loop
 * stays responsive. Results are written to disk directly; only a summary
 * is sent back to the parent thread to avoid large IPC serialization.
 *
 * Parallel mode (default when >1 symbol):
 *   Spawns one symbolWorker.js per symbol (capped at 4 concurrent).
 *   Merges results and computes combined stats in this thread.
 *
 * Sequential mode (parallelSymbols: false in config):
 *   Falls back to single-threaded runBacktestMTF.
 */

const { workerData, parentPort, Worker } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

// Forward any unhandled rejections to the parent so the job is marked failed
process.on('unhandledRejection', (reason) => {
  console.error(`[Worker] unhandledRejection: ${reason}`);
  try { parentPort.postMessage({ type: 'error', message: String(reason) }); } catch {}
  process.exit(1);
});

const { runBacktestMTF, computeStats } = require('./engine.js');

const RESULTS_DIR   = path.resolve(__dirname, '../../data/backtest/results');
const SYMBOL_WORKER = path.resolve(__dirname, './symbolWorker.js');

function sendProgress(update) {
  parentPort.postMessage({ type: 'progress', ...update });
}

const { jobId, config } = workerData;
const symbols = config.symbols || ['MNQ'];

// Use parallel mode by default when there are multiple symbols.
// Set parallelSymbols: false in the config to force sequential execution.
const useParallel = config.parallelSymbols !== false && symbols.length > 1;

// ─── Sequential fallback ──────────────────────────────────────────────────────

if (!useParallel) {
  runBacktestMTF(config, sendProgress)
    .then(results => {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const outPath = path.join(RESULTS_DIR, `${jobId}.json`);
      fs.writeFileSync(outPath, JSON.stringify({ jobId, ...results }));
      console.log(`[Worker] Job ${jobId} saved → ${outPath}`);
      parentPort.postMessage({ type: 'complete', stats: results.stats });
    })
    .catch(err => {
      console.error(`[Worker] Job ${jobId} error: ${err.message}`);
      parentPort.postMessage({ type: 'error', message: err.message });
    });

} else {
  // ─── Parallel mode ────────────────────────────────────────────────────────

  const MAX_SYM_WORKERS = Math.min(symbols.length, 4);
  const startMs = Date.now();

  sendProgress({ phase: 'breadth', pct: 5, message: 'Pre-computing market breadth...' });
  sendProgress({ phase: 'processing', pct: 15, message: `Processing ${symbols.length} symbols in parallel...` });

  // Run up to MAX_SYM_WORKERS symbol workers concurrently
  async function runSymbolsInParallel() {
    const pending = [...symbols];
    let completedSymbols = 0;
    const allTrades = [];
    const mergedEquityMap = {};
    let totalBarsProcessed = 0;
    const errors = [];

    await new Promise((resolve) => {
      const active = new Set();

      function spawnNext() {
        while (active.size < MAX_SYM_WORKERS && pending.length > 0) {
          const sym = pending.shift();
          const w = new Worker(SYMBOL_WORKER, { workerData: { symbol: sym, config } });
          active.add(w);

          w.on('message', msg => {
            if (msg.type === 'complete') {
              active.delete(w);
              completedSymbols++;

              // Merge this symbol's results
              allTrades.push(...msg.trades);
              totalBarsProcessed += msg.totalBarsProcessed || 0;
              for (const [date, pnl] of Object.entries(msg.equityMap)) {
                mergedEquityMap[date] = (mergedEquityMap[date] || 0) + pnl;
              }

              const pct = Math.round(15 + (completedSymbols / symbols.length) * 82);
              sendProgress({
                phase: 'processing',
                pct,
                message: `${msg.symbol} complete (${completedSymbols}/${symbols.length})`,
              });

              spawnNext();
              if (completedSymbols === symbols.length) resolve();
            } else if (msg.type === 'error') {
              // Symbol worker reported an error via postMessage — count it as done
              console.error(`[Worker] Symbol worker ${sym} error: ${msg.message}`);
              errors.push({ sym, message: msg.message });
              active.delete(w);
              completedSymbols++;

              const pct = Math.round(15 + (completedSymbols / symbols.length) * 82);
              sendProgress({
                phase: 'processing',
                pct,
                message: `${sym} failed (${completedSymbols}/${symbols.length})`,
              });

              spawnNext();
              if (completedSymbols === symbols.length) resolve();
            }
          });

          w.on('error', err => {
            console.error(`[Worker] Symbol worker error for ${sym}: ${err.message}`);
            errors.push({ sym, message: err.message });
            active.delete(w);
            completedSymbols++;
            spawnNext();
            if (completedSymbols === symbols.length) resolve();
          });

          w.on('exit', code => {
            // Guard: if worker exits without sending 'complete', count it as done
            if (active.has(w)) {
              active.delete(w);
              completedSymbols++;
              errors.push({ sym, message: `Worker exited with code ${code}` });
              spawnNext();
              if (completedSymbols === symbols.length) resolve();
            }
          });
        }
      }

      spawnNext();
    });

    if (errors.length > 0) {
      console.warn(`[Worker] ${errors.length} symbol worker error(s):`, errors);
    }

    return { allTrades, mergedEquityMap, totalBarsProcessed };
  }

  runSymbolsInParallel()
    .then(({ allTrades, mergedEquityMap, totalBarsProcessed }) => {
      // Build combined equity curve (sorted by date, cumulative)
      const equity = [];
      let cumPnl = 0;
      for (const date of Object.keys(mergedEquityMap).sort()) {
        cumPnl += mergedEquityMap[date];
        equity.push({ date, pnl: +mergedEquityMap[date].toFixed(2), cumPnl: +cumPnl.toFixed(2) });
      }

      const stats = computeStats(allTrades, equity);

      console.log(`[Worker] Job ${jobId} parallel complete: ${allTrades.length} trades, WR=${(stats.winRate * 100).toFixed(1)}%, PF=${stats.profitFactor}, Net=$${stats.grossPnl}`);

      const results = {
        config,
        alerts: allTrades,
        trades: allTrades,
        equity,
        stats,
        meta: {
          totalBarsProcessed,
          durationMs: Date.now() - startMs,
          completedAt: new Date().toISOString(),
          parallelSymbols: true,
        },
      };

      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const outPath = path.join(RESULTS_DIR, `${jobId}.json`);
      fs.writeFileSync(outPath, JSON.stringify({ jobId, ...results }));
      console.log(`[Worker] Job ${jobId} saved → ${outPath}`);

      parentPort.postMessage({ type: 'complete', stats });
    })
    .catch(err => {
      console.error(`[Worker] Job ${jobId} parallel error: ${err.message}`);
      parentPort.postMessage({ type: 'error', message: err.message });
    });
}
