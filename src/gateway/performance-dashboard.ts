import type { Database } from '../db';

/** Read the trade logger schema; realized P&L marks a closed entry. */
export function getPerformanceDashboard(db: Database) {
  // Get trade statistics from database
  const trades = db.query<{
    id: string;
    timestamp: string;
    market: string;
    side: string;
    size: number;
    entryPrice: number;
    exitPrice: number | null;
    pnl: number | null;
    pnlPct: number | null;
    status: string;
    strategy: string | null;
  }>(`
    SELECT
      t.id,
      t.created_at as timestamp,
      COALESCE(t.market_question, t.market_id) as market,
      t.side,
      t.size,
      COALESCE(entry.price, t.price) as entryPrice,
      CASE WHEN t.entry_trade_id IS NOT NULL THEN t.price ELSE exit.price END as exitPrice,
      t.realized_pnl as pnl,
      t.realized_pnl_pct as pnlPct,
      t.status,
      COALESCE(t.strategy_name, t.strategy_id) as strategy
    FROM trades t
    LEFT JOIN trades entry ON entry.id = t.entry_trade_id
    LEFT JOIN trades exit ON exit.id = t.exit_trade_id
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 100
  `);

  // Calculate stats
  const closedTrades = trades.filter(t => t.pnl != null);
  const winningTrades = closedTrades.filter(t => (t.pnl ?? 0) > 0);

  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const avgPnlPct = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / closedTrades.length
    : 0;

  // Calculate Sharpe ratio (simplified - daily returns as percentages)
  const dailyPnlPct: Record<string, number> = {};
  const dailyPnl: Record<string, number> = {};
  for (const t of closedTrades) {
    const date = t.timestamp.split('T')[0];
    dailyPnlPct[date] = (dailyPnlPct[date] ?? 0) + (t.pnlPct ?? 0);
    dailyPnl[date] = (dailyPnl[date] ?? 0) + (t.pnl ?? 0);
  }
  const dailyReturns = Object.values(dailyPnlPct);
  const avgReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;
  const stdDev = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (dailyReturns.length - 1))
    : 0;
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Calculate max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  const dailyData: Array<{ date: string; pnl: number; cumulative: number }> = [];

  const sortedDates = Object.keys(dailyPnl).sort();
  for (const date of sortedDates) {
    cumulative += dailyPnl[date];
    peak = Math.max(peak, cumulative);
    const drawdown = peak !== 0 ? (peak - cumulative) / Math.abs(peak) : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    dailyData.push({ date, pnl: dailyPnl[date], cumulative });
  }

  // Group by strategy
  const strategyMap: Record<string, { trades: number; wins: number; pnl: number }> = Object.create(null);
  for (const t of closedTrades) {
    const strat = t.strategy ?? 'Unknown';
    if (!strategyMap[strat]) {
      strategyMap[strat] = { trades: 0, wins: 0, pnl: 0 };
    }
    strategyMap[strat].trades++;
    if ((t.pnl ?? 0) > 0) strategyMap[strat].wins++;
    strategyMap[strat].pnl += t.pnl ?? 0;
  }

  const byStrategy = Object.entries(strategyMap).map(([strategy, data]) => ({
    strategy,
    trades: data.trades,
    winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    pnl: data.pnl,
  }));

  // Format recent trades
  const recentTrades = trades.slice(0, 20).map(t => ({
    id: t.id,
    timestamp: t.timestamp,
    market: t.market,
    side: t.side,
    size: t.size,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice ?? undefined,
    pnl: t.pnl ?? undefined,
    pnlPct: t.pnlPct ?? undefined,
    status: t.pnl != null
      ? ((t.pnl ?? 0) > 0 ? 'win' : 'loss')
      : t.status,
  }));

  return {
    stats: {
      totalTrades: trades.length,
      winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
      totalPnl,
      avgPnlPct,
      sharpeRatio,
      maxDrawdown: maxDrawdown * 100,
    },
    recentTrades,
    dailyPnl: dailyData,
    byStrategy,
  };
}
