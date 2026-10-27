const { test } = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { createTradeLogger } = require('../../dist/trading/logger.js');
const { getPerformanceDashboard } = require('../../dist/gateway/performance-dashboard.js');

async function fixture() {
  const SQL = await initSqlJs();
  const sql = new SQL.Database();
  const db = {
    run(statement, params = []) { sql.run(statement, params); },
    query(statement, params = []) {
      const stmt = sql.prepare(statement);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally { stmt.free(); }
    },
  };
  return { sql, db, logger: createTradeLogger(db) };
}

test('fresh trade logger schema returns an empty dashboard without SQL errors', async () => {
  const { sql, db } = await fixture();
  try {
    const result = getPerformanceDashboard(db);
    assert.deepEqual(result.stats, { totalTrades: 0, winRate: 0, totalPnl: 0, avgPnlPct: 0, sharpeRatio: 0, maxDrawdown: 0 });
    assert.deepEqual(result.recentTrades, []);
    assert.deepEqual(result.dailyPnl, []);
    assert.deepEqual(result.byStrategy, []);
  } finally { sql.close(); }
});

test('linked filled trades use realized P&L, actual prices and strategy columns without double counting', async () => {
  const { sql, db, logger } = await fixture();
  try {
    const base = { platform: 'polymarket', marketId: 'm1', marketQuestion: 'Example market', outcome: 'Yes', orderType: 'limit', size: 10, filled: 10, status: 'filled', strategyId: 'momentum', strategyName: 'Momentum' };
    const entry = logger.logTrade({ ...base, side: 'buy', price: 0.4 });
    const exit = logger.logTrade({ ...base, side: 'sell', price: 0.6 });
    logger.linkTrades(entry.id, exit.id, 2);
    const pending = logger.logTrade({ ...base, marketId: 'pending', side: 'buy', price: 0.5, filled: 0, status: 'pending' });
    const data = getPerformanceDashboard(db);
    assert.equal(data.stats.totalTrades, 3);
    assert.equal(data.stats.totalPnl, 2);
    assert.equal(data.stats.avgPnlPct, 50);
    assert.equal(data.stats.winRate, 100);
    assert.equal(data.dailyPnl[0].pnl, 2);
    assert.deepEqual(data.byStrategy, [{ strategy: 'Momentum', trades: 1, winRate: 100, pnl: 2 }]);
    const closed = data.recentTrades.find(t => t.id === entry.id);
    assert.equal(closed.status, 'win');
    assert.equal(closed.entryPrice, 0.4);
    assert.equal(closed.exitPrice, 0.6);
    assert.equal(data.recentTrades.find(t => t.id === pending.id).status, 'pending');
  } finally { sql.close(); }
});

test('zero and negative realized returns are retained, including strategy names matching Object properties', async () => {
  const { sql, db, logger } = await fixture();
  try {
    const base = { platform: 'polymarket', marketId: 'm', outcome: 'Yes', side: 'buy', orderType: 'limit', price: 0.5, size: 10, status: 'filled', strategyName: 'constructor' };
    logger.logTrade({ ...base, realizedPnL: 0, realizedPnLPct: 0 });
    logger.logTrade({ ...base, realizedPnL: -1, realizedPnLPct: -20 });
    const data = getPerformanceDashboard(db);
    assert.equal(data.stats.totalPnl, -1);
    assert.equal(data.stats.winRate, 0);
    assert.equal(data.recentTrades.find(t => t.pnl === 0).pnlPct, 0);
    assert.equal(data.byStrategy[0].strategy, 'constructor');
    assert.equal(data.byStrategy[0].trades, 2);
  } finally { sql.close(); }
});
