export interface BybitEnvironmentConfig {
  demo?: boolean;
  testnet?: boolean;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value && value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return value === 'true';
}

/** Environment safety flags cannot be disabled by a caller's false default. */
export function resolveBybitEnvironment(config: BybitEnvironmentConfig = {}) {
  const demo = config.demo === true || envFlag('BYBIT_DEMO');
  const testnet = config.testnet === true || envFlag('BYBIT_TESTNET');
  if (demo && testnet) throw new Error('Bybit Demo and testnet cannot be combined. Set BYBIT_TESTNET=false for Demo.');
  return {
    demo,
    testnet,
    environment: demo ? 'demo' as const : testnet ? 'testnet' as const : 'live' as const,
    baseUrl: demo ? 'https://api-demo.bybit.com' : testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com',
  };
}

export function isBybitDryRun(config: { dryRun?: boolean } = {}): boolean {
  return config.dryRun === true || envFlag('DRY_RUN');
}
