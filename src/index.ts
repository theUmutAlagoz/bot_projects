import { CONFIG } from './config';
import { BinancePriceFeed, MomentumData } from './binance/price-feed';
import { PolymarketMarkets, ParsedMarket } from './polymarket/markets';
import { StrategyEngine, SignalResult } from './strategy/engine';
import { TradeLogger, TradeRecord } from './tracker/trade-logger';
import { startDashboard, updateDashboardMarket } from './dashboard/server';

// ============================================================
//  POLYMARKET BTC 5-MINUTE PREDICTION BOT
//  
//  Strategies:
//    1. Momentum Catcher: Detects strong BTC moves, trades early
//    2. Last-Second Sniper: Trades near-certain outcomes late
//
//  Modes:
//    - Preview: Logs trades without executing (paper trading)
//    - Live: Executes real trades on Polymarket
// ============================================================

class PolymarketBot {
    private priceFeed: BinancePriceFeed;
    private markets: PolymarketMarkets;
    private strategy: StrategyEngine;
    private logger: TradeLogger;

    private isRunning = false;
    private currentMarket: ParsedMarket | null = null;
    private lastMarketId: string = '';
    private mainLoopInterval: NodeJS.Timeout | null = null;
    private marketRefreshInterval: NodeJS.Timeout | null = null;

    // Track the "price to beat" for sniper strategy
    // This is the BTC price at the START of the 5-minute window
    private priceToBeat: number | null = null;
    private priceToBeatMarketId: string = '';

    constructor() {
        this.priceFeed = new BinancePriceFeed();
        this.markets = new PolymarketMarkets();
        this.strategy = new StrategyEngine();
        this.logger = new TradeLogger();
    }

    async start(): Promise<void> {
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                                                              ║');
        console.log('║   ⚡  POLYSNIPER — BTC 5-MIN PREDICTION BOT                  ║');
        console.log('║                                                              ║');
        console.log(`║   Mode: ${CONFIG.mode === 'preview' ? '👁️  PREVIEW (Paper Trading)' : '💰 LIVE (Real Trading)'}            ║`);
        console.log(`║   Trade Size: $${CONFIG.strategy.tradeSize}                                       ║`);
        console.log(`║   Max Daily Loss: $${CONFIG.strategy.maxDailyLoss}                                  ║`);
        console.log(`║   Max Daily Trades: ${CONFIG.strategy.maxDailyTrades}                                    ║`);
        console.log(`║   Signal Cooldown: ${CONFIG.strategy.signalCooldownMs}ms                            ║`);
        console.log(`║   Max Positions/Market: ${CONFIG.strategy.maxPositionsPerMarket}                         ║`);
        console.log('║                                                              ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('');

        if (CONFIG.mode === 'alive' && !CONFIG.polymarket.privateKey) {
            console.error('❌ PRIVATE_KEY is required for live mode!');
            console.error('   Set it in your .env file');
            process.exit(1);
        }

        // Start components
        this.priceFeed.start();

        // Start the dashboard
        startDashboard(this.logger, this.priceFeed);

        // Wait for initial price data
        console.log('⏳ Waiting for BTC price data...');
        await this.waitForPriceData();
        console.log(`✅ Got BTC price: $${this.priceFeed.latestPrice.toFixed(2)}`);

        // In live mode, fetch real Polymarket USDC balance
        if (CONFIG.mode === 'alive') {
            const realBalance = await this.fetchPolymarketBalance();
            if (realBalance !== null) {
                this.logger.setBalance(realBalance);
                console.log(`💰 Polymarket USDC balance: $${realBalance.toFixed(2)}`);
            } else {
                console.log(`💰 Could not fetch balance, using default: $${this.logger.getBalance().toFixed(2)}`);
            }
        }

        // Start main loop
        this.isRunning = true;
        this.mainLoop();

        // Refresh markets periodically
        this.marketRefreshInterval = setInterval(() => this.refreshMarkets(), 10000);

        console.log('');
        console.log(`💵 Trading balance: $${this.logger.getBalance().toFixed(2)}`);
        console.log('🚀 Bot is running! Scanning for trading opportunities...');
        console.log(`📊 Dashboard: http://localhost:${CONFIG.dashboard.port}`);
        console.log('');

        // Handle graceful shutdown
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }

    private async waitForPriceData(): Promise<void> {
        return new Promise((resolve) => {
            if (this.priceFeed.latestPrice > 0) {
                resolve();
                return;
            }
            const check = setInterval(() => {
                if (this.priceFeed.latestPrice > 0) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);
        });
    }

    private async mainLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                await this.tick();
            } catch (error) {
                console.error('❌ Error in main loop:', error);
            }
            // Run every 500ms for responsive trading
            await this.sleep(500);
        }
    }

    private lastPriceRefresh: number = 0;

    private async tick(): Promise<void> {
        // Check risk limits
        const riskCheck = this.logger.shouldStopTrading();
        if (riskCheck.stop) {
            if (this.isRunning) {
                console.log(`🛑 ${riskCheck.reason}`);
                await this.sleep(60000);
            }
            return;
        }

        // Get current momentum data
        const momentum = this.priceFeed.momentum;
        if (momentum.currentPrice === 0) return;

        // Check if current market has expired or doesn't exist
        if (this.currentMarket) {
            this.currentMarket.timeRemainingMs =
                this.currentMarket.endDate.getTime() - Date.now();
        }

        if (!this.currentMarket || this.currentMarket.timeRemainingMs <= 0) {
            // Market expired — resolve pending trades and get next market
            this.resolvePendingTrades(momentum.currentPrice);
            await this.refreshMarkets();
            if (!this.currentMarket) return;
        }

        // Track price to beat (BTC price at the START of this 5-min window)
        // 1. Try to parse from question text ("Will BTC be above $70,300 at 11:50 PM?")
        // 2. Fetch from Binance historical klines at market.startDate
        // 3. Last resort: current BTC price (least accurate)
        if (this.currentMarket.id !== this.priceToBeatMarketId) {
            this.priceToBeatMarketId = this.currentMarket.id;
            const timeLeft = (this.currentMarket.timeRemainingMs / 1000).toFixed(0);
            console.log(`📌 New market: "${this.currentMarket.question}"`);
            console.log(`   UP: ${(this.currentMarket.upPrice * 100).toFixed(1)}¢ | DOWN: ${(this.currentMarket.downPrice * 100).toFixed(1)}¢ | Time left: ${timeLeft}s`);

            if (this.currentMarket.startPrice !== null) {
                // Got it directly from Polymarket data
                this.priceToBeat = this.currentMarket.startPrice;
                console.log(`   Price to beat: $${this.priceToBeat.toFixed(2)} [Polymarket]`);
            } else {
                // Fallback: fetch BTC open price at market start from Binance
                this.priceToBeat = momentum.currentPrice;
                this.fetchBtcPriceAtTime(this.currentMarket.startDate.getTime()).then(historicalPrice => {
                    if (historicalPrice) {
                        this.priceToBeat = historicalPrice;
                        console.log(`   Price to beat: $${historicalPrice.toFixed(2)} [Binance at market start]`);
                    } else {
                        console.log(`   Price to beat: $${this.priceToBeat!.toFixed(2)} [current BTC — fallback]`);
                    }
                });
            }
        }

        // Refresh Polymarket prices every 3 seconds
        const now = Date.now();
        if (now - this.lastPriceRefresh > 3000) {
            this.lastPriceRefresh = now;
            this.currentMarket = await this.markets.refreshMarketPrices(this.currentMarket);
        }

        // Check for expired pending trades
        this.resolvePendingTrades(momentum.currentPrice);

        // Analyze and generate signal
        const signal = this.strategy.analyze(
            momentum,
            this.currentMarket,
            this.priceToBeat
        );

        if (signal) {
            await this.executeTrade(signal, this.currentMarket, momentum);
        }

        // Log status periodically
        this.logStatus(momentum);
    }

    private async executeTrade(
        signal: SignalResult,
        market: ParsedMarket,
        momentum: MomentumData
    ): Promise<void> {
        const mode = CONFIG.mode;
        const isSell = signal.signal.startsWith('SELL');

        if (isSell) {
            // ─── SELL TRADE ───
            const emoji = '💰';
            const modeLabel = mode === 'preview' ? '[PREVIEW]' : '[LIVE]';

            console.log('');
            console.log(`${emoji} ═══════════════════════════════════════════════════`);
            console.log(`${emoji}  ${modeLabel} ${signal.signal} — TAKE PROFIT`);
            console.log(`${emoji}  ${signal.reason}`);
            console.log(`${emoji}  Gain: ${signal.expectedReturn.toFixed(1)}%`);
            console.log(`${emoji}  BTC: $${momentum.currentPrice.toFixed(2)}`);
            console.log(`${emoji}  Time Left: ${(market.timeRemainingMs / 1000).toFixed(0)}s`);
            console.log(`${emoji} ═══════════════════════════════════════════════════`);
            console.log('');

            // Close all matching positions and update trade records
            const positions = this.strategy.getActivePositions();
            const matchingSide = signal.signal === 'SELL_UP' ? 'UP' : 'DOWN';
            for (const pos of positions) {
                if (pos.marketId === market.id && pos.side === matchingSide) {
                    const sellPrice = signal.suggestedPrice;
                    const pnl = (sellPrice - pos.entryPrice) * pos.shares;
                    const emoji = pnl >= 0 ? '✅' : '❌';
                    console.log(`${emoji}  Closed: ${pos.entryPrice.toFixed(3)} → ${sellPrice.toFixed(3)} | P&L: $${pnl.toFixed(2)} | Trade: ${pos.tradeId}`);
                    // Update logger so trade shows correct P&L and balance is updated
                    this.logger.resolveEarlySell(pos.tradeId, sellPrice);
                    this.strategy.closePosition(pos.id);
                }
            }
            return;
        }

        // Dynamic trade sizing: scale with confidence and current balance
        const tradeSize = this.calculateTradeSize(signal);

        // Ensure we have enough paper balance
        if (this.logger.getBalance() < tradeSize) {
            console.log('⚠️  Insufficient paper balance for trade');
            return;
        }

        // ─── BUY TRADE ───
        const trade = this.logger.logTrade(
            signal,
            market.id,
            market.question,
            momentum.currentPrice,
            this.priceToBeat,
            market.timeRemainingMs,
            market.endDate.getTime(),
            tradeSize
        );

        // Register position for tracking
        const side = signal.signal === 'BUY_UP' ? 'UP' : 'DOWN';
        const shares = tradeSize / signal.suggestedPrice;
        this.strategy.registerPosition(
            side as 'UP' | 'DOWN',
            signal.suggestedPrice,
            shares,
            market.id,
            momentum.currentPrice,
            trade.id,
            signal.strategy
        );

        const emoji = signal.strategy === 'contrarian' ? '🔄' :
            signal.signal === 'BUY_UP' ? '🟢' : '🔴';
        const modeLabel = mode === 'preview' ? '[PREVIEW]' : '[LIVE]';

        console.log('');
        console.log(`${emoji} ═══════════════════════════════════════════════════`);
        console.log(`${emoji}  ${modeLabel} ${signal.signal} (${signal.strategy.toUpperCase()})`);
        console.log(`${emoji}  Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
        console.log(`${emoji}  Entry: ${(signal.suggestedPrice * 100).toFixed(1)}¢ | Shares: ${shares.toFixed(2)}`);
        console.log(`${emoji}  Size: $${tradeSize.toFixed(2)} (dynamic)`);
        console.log(`${emoji}  Potential Return: ${signal.expectedReturn.toFixed(0)}% ($${(shares * (1 - signal.suggestedPrice)).toFixed(2)})`);
        console.log(`${emoji}  BTC: $${momentum.currentPrice.toFixed(2)} | Target: ${this.priceToBeat ? '$' + this.priceToBeat.toFixed(2) : 'N/A'}`);
        console.log(`${emoji}  Time Left: ${(market.timeRemainingMs / 1000).toFixed(0)}s`);
        console.log(`${emoji}  Reason: ${signal.reason}`);
        console.log(`${emoji} ═══════════════════════════════════════════════════`);
        console.log('');

        if (mode === 'alive') {
            await this.executeLiveTrade(signal, market, trade);
        }
    }e

    private async fetchPolymarketBalance(): Promise<number | null> {
        try {
            const { ClobClient } = await import('@polymarket/clob-client');
            const { Wallet } = await import('ethers');
            const signer = new Wallet(CONFIG.polymarket.privateKey);
            const creds = await new ClobClient(
                CONFIG.polymarket.host,
                CONFIG.polymarket.chainId,
                signer,
                undefined,
                CONFIG.polymarket.signatureType,
                CONFIG.polymarket.funderAddress
            ).createOrDeriveApiKey();

            const client = new ClobClient(
                CONFIG.polymarket.host,
                CONFIG.polymarket.chainId,
                signer,
                creds,
                CONFIG.polymarket.signatureType,
                CONFIG.polymarket.funderAddress
            );

            const { AssetType } = await import('@polymarket/clob-client');
            const balanceInfo = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            // balance is USDC in wei (6 decimals)
            const usdc = parseFloat(balanceInfo.balance) / 1e6;
            return isNaN(usdc) ? null : usdc;
        } catch {
            return null;
        }
    }

    private async executeLiveTrade(
        signal: SignalResult,
        market: ParsedMarket,
        trade: TradeRecord
    ): Promise<void> {
        try {
            // Dynamic import to avoid issues when SDK is not installed
            const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');
            const { Wallet } = await import('ethers');

            const signer = new Wallet(CONFIG.polymarket.privateKey);
            const creds = await new ClobClient(
                CONFIG.polymarket.host,
                CONFIG.polymarket.chainId,
                signer,
                undefined,
                CONFIG.polymarket.signatureType,
                CONFIG.polymarket.funderAddress
            ).createOrDeriveApiKey();

            const client = new ClobClient(
                CONFIG.polymarket.host,
                CONFIG.polymarket.chainId,
                signer,
                creds,
                CONFIG.polymarket.signatureType,
                CONFIG.polymarket.funderAddress
            );

            // Place the order
            const orderResult = await client.createAndPostOrder(
                {
                    tokenID: signal.tokenId,
                    price: signal.suggestedPrice,
                    side: Side.BUY,
                    size: CONFIG.strategy.tradeSize / signal.suggestedPrice,
                },
                {
                    tickSize: market.tickSize as any,
                    negRisk: market.negRisk,
                },
                OrderType.GTC,
            );

            console.log('✅ Order placed:', JSON.stringify(orderResult).substring(0, 200));
        } catch (error: any) {
            console.error(`❌ Failed to execute live trade: ${error.message}`);
        }
    }

    private resolvePendingTrades(_currentBtcPrice: number): void {
        const pending = this.logger.getPendingTrades();
        for (const trade of pending) {
            if (Date.now() <= trade.marketEndTime) continue;
            if (trade.priceToBeat === null) continue;

            // Fetch the exact BTC price at market end time from Binance
            // so paper-trading resolution matches Polymarket's oracle price.
            this.fetchBtcPriceAtTime(trade.marketEndTime).then(endPrice => {
                const btcAtClose = endPrice ?? _currentBtcPrice;
                const result = btcAtClose >= trade.priceToBeat! ? 'UP_WON' : 'DOWN_WON';
                this.logger.resolveTrade(trade.id, result);

                const emoji = trade.pnl >= 0 ? '✅' : '❌';
                console.log(
                    `${emoji} Trade ${trade.id} resolved: ${result} | ` +
                    `BTC@close: $${btcAtClose.toFixed(0)} vs target: $${trade.priceToBeat!.toFixed(0)} | ` +
                    `P&L: $${trade.pnl.toFixed(2)}`
                );
            });
        }
    }

    private async refreshMarkets(): Promise<void> {
        try {
            const market = await this.markets.getCurrentMarket();
            if (market && market.id !== this.lastMarketId) {
                this.currentMarket = market;
                this.lastMarketId = market.id;
            } else if (!market) {
                this.currentMarket = null;
            }
            updateDashboardMarket(this.currentMarket);
        } catch (error: any) {
            console.error('⚠️  Market refresh error:', error.message);
        }
    }

    private lastLogTime = 0;
    private logStatus(momentum: MomentumData): void {
        const now = Date.now();
        if (now - this.lastLogTime < 5000) return; // Log every 5 seconds max
        this.lastLogTime = now;

        const stats = this.logger.getTodayStats();
        const timeLeft = this.currentMarket ?
            Math.max(0, this.currentMarket.timeRemainingMs / 1000).toFixed(0) : 'N/A';

        const trendEmoji = {
            'STRONG_UP': '🟢🟢',
            'UP': '🟢',
            'NEUTRAL': '⚪',
            'DOWN': '🔴',
            'STRONG_DOWN': '🔴🔴',
        }[momentum.trend];

        // Compact status line
        const targetStr = this.priceToBeat ? `Target: $${this.priceToBeat.toFixed(0)}` : 'Target: N/A';
        console.log(
            `${trendEmoji} BTC: $${momentum.currentPrice.toFixed(0)} | ` +
            `Δ5s: $${momentum.priceChange5s >= 0 ? '+' : ''}${momentum.priceChange5s.toFixed(0)} | ` +
            `v: $${momentum.velocity.toFixed(1)}/s | ` +
            `RSI: ${momentum.rsi14.toFixed(0)} | ` +
            `${targetStr} | ` +
            `⏱️ ${timeLeft}s | ` +
            `📊 W:${stats.wins} L:${stats.losses} | ` +
            `💰 $${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} | ` +
            `💵 Bal: $${this.logger.getBalance().toFixed(2)}`
        );
    }

    /**
     * Fetch BTC/USDT price from Binance at a specific point in time.
     * Uses the 1-minute kline open price for the minute containing that timestamp.
     */
    private async fetchBtcPriceAtTime(timestampMs: number): Promise<number | null> {
        try {
            const url = `${CONFIG.binance.restUrl}/klines?symbol=BTCUSDT&interval=1m&startTime=${timestampMs}&limit=1`;
            const https = await import('https');
            const data = await new Promise<string>((resolve, reject) => {
                https.get(url, (res: any) => {
                    let body = '';
                    res.on('data', (chunk: string) => body += chunk);
                    res.on('end', () => resolve(body));
                    res.on('error', reject);
                }).on('error', reject);
            });
            const klines = JSON.parse(data);
            if (Array.isArray(klines) && klines.length > 0) {
                const openPrice = parseFloat(klines[0][1]); // index 1 = open price
                if (openPrice > 1000 && openPrice < 1000000) return openPrice;
            }
        } catch { }
        return null;
    }

    /**
     * Dynamic trade sizing based on confidence and current balance.
     * Higher confidence = larger bet. Never risk more than 25% of balance.
     * Range: $1 minimum → $8 maximum.
     *   $20 bal, 50% conf → $1.50
     *   $20 bal, 70% conf → $2.10
     *   $20 bal, 90% conf → $2.70
     */
    private calculateTradeSize(signal: SignalResult): number {
        const balance = this.logger.getBalance();
        if (balance <= 0) return 1.00;
        const pct = 0.075 + Math.max(0, signal.confidence - 0.50) * 0.175;
        const dynamic = balance * pct;
        const maxSize = Math.min(balance * 0.25, 8.00);
        return Math.round(Math.max(1.00, Math.min(dynamic, maxSize)) * 100) / 100;
    }

    stop(): void {
        console.log('');
        console.log('🛑 Shutting down bot...');
        this.isRunning = false;
        this.priceFeed.stop();

        if (this.mainLoopInterval) clearInterval(this.mainLoopInterval);
        if (this.marketRefreshInterval) clearInterval(this.marketRefreshInterval);

        // Final stats
        const stats = this.logger.getTodayStats();
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║              📊 SESSION SUMMARY                     ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  Total Trades:  ${stats.totalTrades.toString().padStart(8)}                       ║`);
        console.log(`║  Wins:          ${stats.wins.toString().padStart(8)}                       ║`);
        console.log(`║  Losses:        ${stats.losses.toString().padStart(8)}                       ║`);
        console.log(`║  Win Rate:      ${stats.winRate.toFixed(1).padStart(7)}%                       ║`);
        console.log(`║  Total P&L:     $${stats.totalPnl.toFixed(2).padStart(7)}                       ║`);
        console.log(`║  Balance:       $${this.logger.getBalance().toFixed(2).padStart(7)}                       ║`);
        console.log(`║  ROI:           ${stats.roi.toFixed(1).padStart(7)}%                       ║`);
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  Momentum:  ${stats.strategies.momentum.trades} trades, $${stats.strategies.momentum.pnl.toFixed(2)} P&L     ║`);
        console.log(`║  Sniper:    ${stats.strategies.sniper.trades} trades, $${stats.strategies.sniper.pnl.toFixed(2)} P&L     ║`);
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');

        process.exit(0);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================
//  ENTRY POINT
// ============================================================
const bot = new PolymarketBot();
bot.start().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});
