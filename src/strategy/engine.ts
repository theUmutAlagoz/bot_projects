import { MomentumData } from '../binance/price-feed';
import { ParsedMarket } from '../polymarket/markets';
import { CONFIG } from '../config';

export type TradeSignal = 'BUY_UP' | 'BUY_DOWN' | 'SELL_UP' | 'SELL_DOWN' | 'HOLD';

export interface SignalResult {
    signal: TradeSignal;
    confidence: number;     // 0 to 1
    reason: string;
    strategy: 'momentum' | 'sniper' | 'contrarian' | 'combined';
    suggestedPrice: number; // Suggested limit price
    tokenId: string;        // Which token to buy/sell
    expectedReturn: number; // Expected return percentage
}

interface ActivePosition {
    id: string;
    tradeId: string;        // Links back to TradeLogger record
    side: 'UP' | 'DOWN';
    strategy: string;       // 'contrarian' | 'sniper' etc.
    entryPrice: number;     // Price we bought at (e.g., 0.25)
    shares: number;         // Number of shares
    entryTime: number;      // When we entered
    marketId: string;
    btcPriceAtEntry: number;
}

/**
 * Strategy Engine v2 — Contrarian Mean Reversion + Sniper
 * 
 * PRIMARY STRATEGY: Contrarian (Mean Reversion)
 * =============================================
 * When BTC spikes sharply in one direction, the OPPOSITE outcome
 * becomes very cheap on Polymarket. We buy the cheap side because:
 * 1. BTC tends to revert after sharp moves (mean reversion)
 * 2. Even if it doesn't fully revert, we can sell for profit as
 *    odds normalize
 * 3. At the start of a 5-min window, there's plenty of time for reversal
 * 
 * Example:
 *   BTC spikes UP $100 → DOWN drops to 25¢ → We buy DOWN
 *   BTC reverts back → DOWN rises to 50¢ → We sell for 100% profit
 *   OR: BTC stays below target → DOWN resolves at $1 → 300% profit
 * 
 * SECONDARY STRATEGY: Sniper
 * ==========================
 * In final 60 seconds, if outcome is near-certain, buy the winner.
 * 
 * SELL LOGIC: Take Profit
 * =======================
 * Continuously monitor open positions. Sell when:
 * - Position has gained the profit target percentage
 * - Market odds shifted in our favor
 */
export class StrategyEngine {
    private lastSignalTime: number = 0;
    private signalCooldown: number = CONFIG.strategy.signalCooldownMs;  // Prevent signal spam
    private activePositions: ActivePosition[] = [];
    private positionCounter: number = 0;

    /**
     * Analyze market conditions and generate a trade signal.
     */
    analyze(
        momentum: MomentumData,
        market: ParsedMarket,
        priceToBeat: number | null
    ): SignalResult | null {
        const now = Date.now();

        // Can't trade if market isn't accepting orders
        if (!market.acceptingOrders || market.timeRemainingMs <= 0) {
            return null;
        }

        // First check: Should we SELL any active positions? (always priority)
        const sellSignal = this.checkSellSignals(momentum, market);
        if (sellSignal) {
            return sellSignal;
        }

        // Cooldown check for new buys
        if (now - this.lastSignalTime < this.signalCooldown) {
            return null;
        }

        // Limit number of open positions per market (configurable)
        const maxPositions = Math.max(1, CONFIG.strategy.maxPositionsPerMarket);
        const openPositionsInThisMarket = this.activePositions.filter(
            p => p.marketId === market.id
        ).length;
        if (openPositionsInThisMarket >= maxPositions) {
            return null;
        }

        // Strategy 1: Contrarian (Primary — works best early-mid window)
        // Uses a lower confidence threshold (0.50) because the edge comes from
        // price dislocation, not from certainty of direction.
        const contrarianSignal = this.contrarianStrategy(momentum, market);
        if (contrarianSignal && contrarianSignal.confidence >= 0.50) {
            this.lastSignalTime = now;
            return contrarianSignal;
        }

        // Strategy 2: Sniper (Secondary — works in last 90 seconds)
        const sniperSignal = this.sniperStrategy(momentum, market, priceToBeat);
        if (sniperSignal && sniperSignal.confidence >= CONFIG.strategy.minConfidence) {
            this.lastSignalTime = now;
            return sniperSignal;
        }

        return null;
    }

    /**
     * Register a new position (called after trade is logged)
     */
    registerPosition(
        side: 'UP' | 'DOWN',
        entryPrice: number,
        shares: number,
        marketId: string,
        btcPrice: number,
        tradeId: string,
        strategy: string
    ): string {
        this.positionCounter++;
        const id = `POS-${this.positionCounter}`;
        this.activePositions.push({
            id,
            tradeId,
            side,
            strategy,
            entryPrice,
            shares,
            entryTime: Date.now(),
            marketId,
            btcPriceAtEntry: btcPrice,
        });
        return id;
    }

    /**
     * Remove a position (after sell or resolution)
     */
    closePosition(id: string): void {
        this.activePositions = this.activePositions.filter(p => p.id !== id);
    }

    /**
     * Get all active positions
     */
    getActivePositions(): ActivePosition[] {
        return [...this.activePositions];
    }

    /**
     * CONTRARIAN STRATEGY (Mean Reversion)
     * 
     * When BTC makes a sharp move, buy the OPPOSITE side.
     * The Polymarket order book adjusts slower than Binance,
     * so we can buy cheap before odds fully catch up.
     * 
     * Entry: BTC spike $20+ in 5s → buy opposite at market price
     * Exit: Take profit at 40%+ gain or hold to resolution
     */
    private contrarianStrategy(
        momentum: MomentumData,
        market: ParsedMarket
    ): SignalResult | null {
        const timeRemaining = market.timeRemainingMs / 1000;

        // Need enough time for mean reversion (at least 120 seconds = 2 minutes)
        if (timeRemaining < 120) return null;

        // Need enough data
        if (momentum.priceChange5s === 0 && momentum.priceChange15s === 0) return null;

        const { priceChange5s, priceChange15s, velocity, rsi14 } = momentum;
        let signal: TradeSignal = 'HOLD';
        let confidence = 0;
        let reason = '';

        // ─── SHARP UP SPIKE → BUY DOWN ───
        // $20+ spike with $4+/s velocity = strong move worth fading
        // REQUIRE: DOWN must be cheap (< 0.25) — losing side after the spike
        if (priceChange5s > 20 && velocity > 4 && market.downPrice >= 0.02 && market.downPrice < 0.25) {
            signal = 'BUY_DOWN';
            confidence = 0.45;

            // Bigger spike = more confident in reversal
            if (priceChange5s > 80) confidence += 0.20;
            else if (priceChange5s > 50) confidence += 0.15;
            else if (priceChange5s > 35) confidence += 0.12;
            else if (priceChange5s > 20) confidence += 0.08;

            // RSI overbought = higher chance of reversal
            if (rsi14 > 80) confidence += 0.12;
            else if (rsi14 > 65) confidence += 0.08;

            // Cheaper = more upside potential
            if (market.downPrice < 0.08) confidence += 0.10;
            else if (market.downPrice < 0.15) confidence += 0.07;
            else if (market.downPrice < 0.25) confidence += 0.04;

            // More time = more opportunity for reversion
            if (timeRemaining > 200) confidence += 0.05;

            reason = `Contrarian DOWN: BTC spiked +$${priceChange5s.toFixed(0)} in 5s ` +
                `(v=$${velocity.toFixed(1)}/s, RSI:${rsi14.toFixed(0)}), ` +
                `DOWN at ${(market.downPrice * 100).toFixed(1)}¢`;
        }

        // ─── SHARP DOWN SPIKE → BUY UP ───
        // REQUIRE: UP must be cheap (< 0.25) — losing side after the drop
        else if (priceChange5s < -20 && velocity < -4 && market.upPrice >= 0.02 && market.upPrice < 0.25) {
            signal = 'BUY_UP';
            confidence = 0.45;

            if (priceChange5s < -80) confidence += 0.20;
            else if (priceChange5s < -50) confidence += 0.15;
            else if (priceChange5s < -35) confidence += 0.12;
            else if (priceChange5s < -20) confidence += 0.08;

            if (rsi14 < 20) confidence += 0.12;
            else if (rsi14 < 35) confidence += 0.08;

            if (market.upPrice < 0.08) confidence += 0.10;
            else if (market.upPrice < 0.15) confidence += 0.07;
            else if (market.upPrice < 0.25) confidence += 0.04;

            if (timeRemaining > 200) confidence += 0.05;

            reason = `Contrarian UP: BTC dropped $${Math.abs(priceChange5s).toFixed(0)} in 5s ` +
                `(v=$${velocity.toFixed(1)}/s, RSI:${rsi14.toFixed(0)}), ` +
                `UP at ${(market.upPrice * 100).toFixed(1)}¢`;
        }

        if (signal === 'HOLD') return null;

        confidence = Math.min(confidence, 0.90);

        const tokenId = signal === 'BUY_UP' ? market.upTokenId : market.downTokenId;
        const midPrice = signal === 'BUY_UP' ? market.upPrice : market.downPrice;
        // Use real ask price if available (what we actually pay), fall back to mid
        const askPrice = signal === 'BUY_UP'
            ? (market.upAsk > 0 ? market.upAsk : midPrice)
            : (market.downAsk > 0 ? market.downAsk : midPrice);
        const expectedReturn = ((1 - askPrice) / askPrice) * 100;

        return {
            signal,
            confidence,
            reason,
            strategy: 'contrarian',
            suggestedPrice: askPrice,
            tokenId,
            expectedReturn,
        };
    }

    /**
     * CHECK SELL SIGNALS — Take Profit on Active Positions
     * 
     * Rules:
     * - Take profit at 40%+ gain (e.g., bought at 30¢, sell at 42¢)
     * - Take bigger profit at 60%+ if available
     * - Emergency sell if position losing 30%+ and time running out
     */
    private checkSellSignals(
        momentum: MomentumData,
        market: ParsedMarket
    ): SignalResult | null {
        const timeRemaining = market.timeRemainingMs / 1000;

        for (const pos of this.activePositions) {
            if (pos.marketId !== market.id) continue;

            const currentPrice = pos.side === 'UP' ? market.upPrice : market.downPrice;
            const gainPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

            // ─── TAKE PROFIT ───
            // Contrarian: 15% gain — quick flip on 2-6¢ tokens (e.g. 2¢ → 2.3¢)
            // Sniper: CONFIG take profit (higher, holding to near-resolution)
            const tpThreshold = pos.strategy === 'contrarian' ? 15 : CONFIG.strategy.takeProfitPct;
            if (gainPct >= tpThreshold) {
                const signal: TradeSignal = pos.side === 'UP' ? 'SELL_UP' : 'SELL_DOWN';

                return {
                    signal,
                    confidence: 0.90,
                    reason: `Take Profit (${pos.strategy}): ${pos.side} gained ${gainPct.toFixed(1)}% ` +
                        `(${(pos.entryPrice * 100).toFixed(1)}¢ → ${(currentPrice * 100).toFixed(1)}¢)`,
                    strategy: 'contrarian',
                    suggestedPrice: currentPrice,
                    tokenId: pos.side === 'UP' ? market.upTokenId : market.downTokenId,
                    expectedReturn: gainPct,
                };
            }

            // ─── STOP LOSS with time pressure ───
            // If losing 25%+ AND less than 30 seconds left → cut losses
            if (gainPct < -25 && timeRemaining < 30) {
                const signal: TradeSignal = pos.side === 'UP' ? 'SELL_UP' : 'SELL_DOWN';

                return {
                    signal,
                    confidence: 0.85,
                    reason: `Stop Loss: ${pos.side} losing ${gainPct.toFixed(1)}% with ${timeRemaining.toFixed(0)}s left`,
                    strategy: 'contrarian',
                    suggestedPrice: currentPrice,
                    tokenId: pos.side === 'UP' ? market.upTokenId : market.downTokenId,
                    expectedReturn: gainPct,
                };
            }
        }

        return null;
    }

    /**
     * SNIPER STRATEGY — Last-second certainty plays
     */
    private sniperStrategy(
        momentum: MomentumData,
        market: ParsedMarket,
        priceToBeat: number | null
    ): SignalResult | null {
        const timeRemaining = market.timeRemainingMs / 1000;

        // Only in last 90 seconds
        if (timeRemaining > 90 || timeRemaining < 5) return null;
        if (!priceToBeat || priceToBeat <= 0) return null;

        const currentBtcPrice = momentum.currentPrice;
        const priceGap = currentBtcPrice - priceToBeat;
        const absGap = Math.abs(priceGap);
        const minGap = CONFIG.strategy.sniperMinGap;

        if (absGap < minGap) return null;

        let signal: TradeSignal = 'HOLD';
        let confidence = 0;
        let reason = '';

        if (priceGap > 0) {
            signal = 'BUY_UP';
            confidence = 0.55;

            if (absGap > 200) confidence += 0.15;
            else if (absGap > 100) confidence += 0.10;
            else if (absGap > 50) confidence += 0.05;

            if (timeRemaining < 15) confidence += 0.15;
            else if (timeRemaining < 30) confidence += 0.10;
            else if (timeRemaining < 45) confidence += 0.05;

            if (momentum.velocity > 0) confidence += 0.05;

            reason = `Sniper UP: BTC=$${currentBtcPrice.toFixed(0)} > target=$${priceToBeat.toFixed(0)} ` +
                `(+$${absGap.toFixed(0)}), ${timeRemaining.toFixed(0)}s left`;
        } else {
            signal = 'BUY_DOWN';
            confidence = 0.55;

            if (absGap > 200) confidence += 0.15;
            else if (absGap > 100) confidence += 0.10;
            else if (absGap > 50) confidence += 0.05;

            if (timeRemaining < 15) confidence += 0.15;
            else if (timeRemaining < 30) confidence += 0.10;
            else if (timeRemaining < 45) confidence += 0.05;

            if (momentum.velocity < 0) confidence += 0.05;

            reason = `Sniper DOWN: BTC=$${currentBtcPrice.toFixed(0)} < target=$${priceToBeat.toFixed(0)} ` +
                `(-$${absGap.toFixed(0)}), ${timeRemaining.toFixed(0)}s left`;
        }

        confidence = Math.min(confidence, 0.95);

        const tokenId = signal === 'BUY_UP' ? market.upTokenId : market.downTokenId;
        const midPrice = signal === 'BUY_UP' ? market.upPrice : market.downPrice;
        // Use real ask price if available, fall back to mid + 1 tick
        const askPrice = signal === 'BUY_UP'
            ? (market.upAsk > 0 ? market.upAsk : midPrice + 0.01)
            : (market.downAsk > 0 ? market.downAsk : midPrice + 0.01);
        const expectedReturn = ((1 - askPrice) / askPrice) * 100;

        return {
            signal,
            confidence,
            reason,
            strategy: 'sniper',
            suggestedPrice: Math.min(askPrice, 0.99),
            tokenId,
            expectedReturn,
        };
    }
}
