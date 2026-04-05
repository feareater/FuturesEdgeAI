'use strict';
/**
 * worker.js — Backtest worker thread entry point
 *
 * Runs runBacktestMTF in a dedicated thread so the main Express event loop
 * stays responsive. Results are written to disk directly; only a summary
 * is sent back to the parent thread to avoid large IPC serialization.
 */

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const { runBacktestMTF } = require('./engine.js');

const RESULTS_DIR = path.resolve(__dirname, '../../data/backtest/results');

function sendProgress(update) {
  parentPort.postMessage({ type: 'progress', ...update });
}

const { jobId, config } = workerData;

runBacktestMTF(config, sendProgress)
  .then(results => {
    // Write results to disk (same path as launchBacktest)
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = path.join(RESULTS_DIR, `${jobId}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ jobId, ...results }));
    console.log(`[Worker] Job ${jobId} saved → ${outPath}`);

    // Send compact complete message — no need to serialize full trade array over IPC
    parentPort.postMessage({ type: 'complete', stats: results.stats });
  })
  .catch(err => {
    console.error(`[Worker] Job ${jobId} error: ${err.message}`);
    parentPort.postMessage({ type: 'error', message: err.message });
  });
