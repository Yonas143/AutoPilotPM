import { getBalance, resolveBybitEnvironment, isBybitDryRun } from './index';

/** Always read the Demo wallet, even before the global demo flag is configured. */
export async function checkBybitDemoConnection(): Promise<string> {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return 'Bybit Demo: credentials missing. Set BYBIT_API_KEY and BYBIT_API_SECRET privately in Render.';
  try {
    const environment = resolveBybitEnvironment({ demo: true });
    const balances = await getBalance({ apiKey, apiSecret, demo: true });
    const globalEnvironment = resolveBybitEnvironment();
    return [
      'Bybit Demo connection verified (read-only).',
      `Endpoint: ${environment.baseUrl}`,
      `App Bybit routing: ${globalEnvironment.environment}`,
      `Order simulation: ${isBybitDryRun() ? 'enabled' : 'disabled'}`,
      balances.length ? 'Demo wallet equity:\n' + balances.map(b => `${b.coin}: ${b.equity}`).join('\n') : 'Demo wallet: no positive coin balances.',
      'No orders were placed.',
    ].join('\n');
  } catch (error) {
    // SDK failures can contain signed requests. Never return the raw error object.
    const e = error as { retCode?: number; code?: unknown; response?: { status?: number; data?: { retCode?: number } } };
    const code = e?.retCode ?? e?.response?.data?.retCode;
    const http = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
    const detail = typeof code === 'number' ? ` (Bybit code ${code})` : typeof http === 'number' ? ` (HTTP ${http})` : '';
    return `Bybit Demo connection could not be verified${detail}. Check that the keys were created in Demo Trading, wallet read permission is enabled, and BYBIT_TESTNET=false. No orders were placed.`;
  }
}
