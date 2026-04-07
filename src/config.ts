import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
    // Bot Mode
    mode: (process.env.BOT_MODE || 'preview') as 'preview' | 'alive',

    // Polymarket
    polymarket: {
        host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
        chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
        privateKey: process.env.PRIVATE_KEY || '',
        funderAddress: process.env.FUNDER_ADDRESS || '',
        signatureType: parseInt(process.env.SIGNATURE_TYPE || '1'),
    },

    // Gamma API (public, no auth needed)
    gammaApi: 'https://gamma-api.polymarket.com',

    // CLOB API
    clobApi: 'https://clob.polymarket.com',

    // Strategy
    strategy: {
        tradeSize: parseFloat(process.env.TRADE_SIZE || '2'),
        maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '10'),
        maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '50'),
        momentumThreshold: parseFloat(process.env.MOMENTUM_THRESHOLD || '15'),
        sniperMinSeconds: parseInt(process.env.SNIPER_MIN_SECONDS || '30'),
        sniperMinGap: parseFloat(process.env.SNIPER_MIN_GAP || '50'),
        minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.60'),
        takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '40'),
        stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '25'),
        // Advanced tuning
        signalCooldownMs: parseInt(process.env.SIGNAL_COOLDOWN_MS || '15000'),
        maxPositionsPerMarket: parseInt(process.env.MAX_POSITIONS_PER_MARKET || '2'),
    },

    // Dashboard
    dashboard: {
        port: parseInt(process.env.DASHBOARD_PORT || '3000'),
    },

    // Paper trading / accounting
    startingBalance: parseFloat(process.env.STARTING_BALANCE || '20'),

    // Binance WebSocket
    binance: {
        wsUrl: 'wss://stream.binance.com:9443/ws/btcusdt@trade',
        restUrl: 'https://api.binance.com/api/v3',
    },
};
