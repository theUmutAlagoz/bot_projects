import { CONFIG } from '../config';
import { SignalResult } from '../strategy/engine';

export interface TradeRecord {
    id: string;
    timestamp: number;
    date: string;
    marketId: string;
    marketQuestion: string;
    signal: string;
    strategy: string;
    confidence: number;
    tokenId: string;
    side: 'UP' | 'DOWN';
    entryPrice: number;        // Price paid per share
    size: number;              // USDC amount
    shares: number;            // Number of shares bought
    status: 'pending' | 'won' | 'lost' | 'expired';
    pnl: number;               // Profit/Loss in USDC
    reason: string;
    mode: 'preview' | 'live';
    btcPriceAtEntry: number;
    priceToBeat: number | null;
    timeRemainingAtEntry: number;
    marketEndTime: number;         // Unix ms when market ends (for accurate resolution)
    result?: 'UP_WON' | 'DOWN_WON' | 'UNKNOWN';
}

export interface DailyStats {
    date: string;
    totalTrades: number;
    wins: number;
    losses: number;
    pending: number;
    winRate: number;
    totalPnl: number;
    totalInvested: number;
    roi: number;
    bestTrade: number;
    worstTrade: number;
    avgConfidence: number;
    strategies: {
        momentum: { trades: number; wins: number; pnl: number };
        sniper: { trades: number; wins: number; pnl: number };
    };
}

export class TradeLogger {
    private trades: TradeRecord[] = [];
    private tradeCounter = 0;
    private startingBalance: number = CONFIG.startingBalance;
    private balance: number = CONFIG.startingBalance;

    /**
     * Log a new trade (preview or live)
     */
    logTrade(
        signal: SignalResult,
        marketId: string,
        marketQuestion: string,
        btcPrice: number,
        priceToBeat: number | null,
        timeRemainingMs: number,
        marketEndTime: number,
        tradeSizeOverride?: number,
    ): TradeRecord {
        this.tradeCounter++;
        const tradeSize = tradeSizeOverride ?? CONFIG.strategy.tradeSize;
        const shares = tradeSize / signal.suggestedPrice;

        const trade: TradeRecord = {
            id: `T${this.tradeCounter.toString().padStart(5, '0')}`,
            timestamp: Date.now(),
            date: new Date().toISOString().split('T')[0],
            marketId,
            marketQuestion,
            signal: signal.signal,
            strategy: signal.strategy,
            confidence: signal.confidence,
            tokenId: signal.tokenId,
            side: signal.signal === 'BUY_UP' ? 'UP' : 'DOWN',
            entryPrice: signal.suggestedPrice,
            size: tradeSize,
            shares,
            status: 'pending',
            pnl: 0,
            reason: signal.reason,
            mode: CONFIG.mode,
            btcPriceAtEntry: btcPrice,
            priceToBeat,
            timeRemainingAtEntry: timeRemainingMs / 1000,
            marketEndTime,
        };

        this.trades.push(trade);
        // Deduct trade cost from balance immediately when trade is opened
        this.balance -= tradeSize;
        return trade;
    }

    /**
     * Resolve a trade via early sell (take profit / stop loss before market ends).
     * P&L = (sellPrice - entryPrice) * shares
     * Balance gets back the sell proceeds (not the full entry — we already deducted that).
     */
    resolveEarlySell(tradeId: string, sellPrice: number): void {
        const trade = this.trades.find(t => t.id === tradeId);
        if (!trade || trade.status !== 'pending') return;

        trade.pnl = (sellPrice - trade.entryPrice) * trade.shares;
        trade.status = trade.pnl >= 0 ? 'won' : 'lost';
        trade.result = 'UNKNOWN';

        // Return sell proceeds to balance (entry cost already deducted on open)
        this.balance += sellPrice * trade.shares;
    }

    /**
     * Resolve a trade as won or lost
     */
    resolveTrade(tradeId: string, result: 'UP_WON' | 'DOWN_WON'): void {
        const trade = this.trades.find(t => t.id === tradeId);
        if (!trade || trade.status !== 'pending') return;

        trade.result = result;

        const didWin = (trade.side === 'UP' && result === 'UP_WON') ||
            (trade.side === 'DOWN' && result === 'DOWN_WON');

        if (didWin) {
            trade.status = 'won';
            // Won: get $1 per share, paid entryPrice per share
            trade.pnl = trade.shares * (1 - trade.entryPrice);
        } else {
            trade.status = 'lost';
            // Lost: lose entire investment
            trade.pnl = -trade.size;
        }

        // Update paper trading balance.
        // Entry cost was already deducted on open, so:
        //   Won  → return investment + profit  (size + pnl)
        //   Lost → investment already gone, nothing to add (pnl = -size, so +0 net)
        if (didWin) {
            this.balance += trade.size + trade.pnl;
        }
        // Lost: balance is already correct (entry cost was deducted on open)
    }

    /**
     * Override balance with real on-chain balance (used in live mode at startup)
     */
    setBalance(amount: number): void {
        this.startingBalance = amount;
        this.balance = amount;
    }

    /**
     * Current paper-trading balance (starting balance + realized PnL)
     */
    getBalance(): number {
        return this.balance;
    }

    /**
     * Starting balance used for paper trading
     */
    getStartingBalance(): number {
        return this.startingBalance;
    }

    /**
     * Get today's statistics
     */
    getTodayStats(): DailyStats {
        const today = new Date().toISOString().split('T')[0];
        return this.getStatsForDate(today);
    }

    /**
     * Get statistics for a specific date
     */
    getStatsForDate(date: string): DailyStats {
        const dayTrades = this.trades.filter(t => t.date === date);
        const wins = dayTrades.filter(t => t.status === 'won');
        const losses = dayTrades.filter(t => t.status === 'lost');
        const pending = dayTrades.filter(t => t.status === 'pending');

        const totalPnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
        const totalInvested = dayTrades.reduce((sum, t) => sum + t.size, 0);

        const momentumTrades = dayTrades.filter(t => t.strategy === 'momentum' || t.strategy === 'contrarian' || t.strategy === 'combined');
        const sniperTrades = dayTrades.filter(t => t.strategy === 'sniper');

        return {
            date,
            totalTrades: dayTrades.length,
            wins: wins.length,
            losses: losses.length,
            pending: pending.length,
            winRate: (wins.length + losses.length) > 0 ? wins.length / (wins.length + losses.length) * 100 : 0,
            totalPnl,
            totalInvested,
            roi: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
            bestTrade: dayTrades.length > 0 ? Math.max(...dayTrades.map(t => t.pnl)) : 0,
            worstTrade: dayTrades.length > 0 ? Math.min(...dayTrades.map(t => t.pnl)) : 0,
            avgConfidence: dayTrades.length > 0 ?
                dayTrades.reduce((sum, t) => sum + t.confidence, 0) / dayTrades.length : 0,
            strategies: {
                momentum: {
                    trades: momentumTrades.length,
                    wins: momentumTrades.filter(t => t.status === 'won').length,
                    pnl: momentumTrades.reduce((sum, t) => sum + t.pnl, 0),
                },
                sniper: {
                    trades: sniperTrades.length,
                    wins: sniperTrades.filter(t => t.status === 'won').length,
                    pnl: sniperTrades.reduce((sum, t) => sum + t.pnl, 0),
                },
            },
        };
    }

    /**
     * Get all trades
     */
    getAllTrades(): TradeRecord[] {
        return [...this.trades];
    }

    /**
     * Get recent trades
     */
    getRecentTrades(count: number = 20): TradeRecord[] {
        return this.trades.slice(-count);
    }

    /**
     * Get total P&L
     */
    getTotalPnl(): number {
        return this.trades.reduce((sum, t) => sum + t.pnl, 0);
    }

    /**
     * Get today's trade count
     */
    getTodayTradeCount(): number {
        const today = new Date().toISOString().split('T')[0];
        return this.trades.filter(t => t.date === today).length;
    }

    /**
     * Get today's total loss
     */
    getTodayLoss(): number {
        const today = new Date().toISOString().split('T')[0];
        return this.trades
            .filter(t => t.date === today && t.pnl < 0)
            .reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    }

    /**
     * Check if we should stop trading (risk limits)
     */
    shouldStopTrading(): { stop: boolean; reason: string } {
        const todayLoss = this.getTodayLoss();
        const todayTrades = this.getTodayTradeCount();

        if (todayLoss >= CONFIG.strategy.maxDailyLoss) {
            return {
                stop: true,
                reason: `Daily loss limit reached: $${todayLoss.toFixed(2)} >= $${CONFIG.strategy.maxDailyLoss}`,
            };
        }

        if (todayTrades >= CONFIG.strategy.maxDailyTrades) {
            return {
                stop: true,
                reason: `Daily trade limit reached: ${todayTrades} >= ${CONFIG.strategy.maxDailyTrades}`,
            };
        }

        return { stop: false, reason: '' };
    }

    /**
     * Get pending trades that need resolution
     */
    getPendingTrades(): TradeRecord[] {
        return this.trades.filter(t => t.status === 'pending');
    }
}
