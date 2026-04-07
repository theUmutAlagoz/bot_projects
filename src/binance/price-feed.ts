import WebSocket from 'ws';
import https from 'https';
import { EventEmitter } from 'events';
import { CONFIG } from '../config';

export interface PriceTick {
    price: number;
    quantity: number;
    timestamp: number;
}

export interface MomentumData {
    currentPrice: number;
    priceChange1s: number;   // Price change over last 1 second
    priceChange5s: number;   // Price change over last 5 seconds
    priceChange15s: number;  // Price change over last 15 seconds
    priceChange60s: number;  // Price change over last 60 seconds
    velocity: number;        // $ per second (avg over 5s)
    acceleration: number;    // Change in velocity
    volume1s: number;        // Volume in last 1 second
    rsi14: number;           // 14-period RSI on 1s closes
    trend: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
}

export class BinancePriceFeed extends EventEmitter {
    private ws: WebSocket | null = null;
    private prices: PriceTick[] = [];
    private closes1s: number[] = [];        // 1-second close prices for RSI
    private currentSecondPrices: number[] = [];
    private lastSecondTimestamp: number = 0;
    private reconnectAttempts = 0;
    private isRunning = false;
    private gains: number[] = [];
    private losses: number[] = [];
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private restPollInterval: NodeJS.Timeout | null = null;
    private usingRestFallback = false;

    // Max WS attempts before falling back to REST polling
    private readonly WS_MAX_ATTEMPTS = 5;

    // Keep last 5 minutes of data (300 seconds of ticks)
    private readonly MAX_HISTORY = 30000; // ~30k ticks (BTC trades ~100/sec)
    private readonly MAX_1S_CLOSES = 300;

    public latestPrice: number = 0;
    public momentum: MomentumData = {
        currentPrice: 0,
        priceChange1s: 0,
        priceChange5s: 0,
        priceChange15s: 0,
        priceChange60s: 0,
        velocity: 0,
        acceleration: 0,
        volume1s: 0,
        rsi14: 50,
        trend: 'NEUTRAL',
    };

    start(): void {
        this.isRunning = true;
        this.connect();
        console.log('📡 Binance BTC Price Feed started');
    }

    stop(): void {
        this.isRunning = false;
        this.cleanupConnection();
        if (this.restPollInterval) {
            clearInterval(this.restPollInterval);
            this.restPollInterval = null;
        }
        console.log('📡 Binance BTC Price Feed stopped');
    }

    private cleanupConnection(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) {
                // ignore
            }
            this.ws = null;
        }
    }

    private connect(): void {
        if (!this.isRunning) return;

        // Clean up any existing connection first
        this.cleanupConnection();

        this.ws = new WebSocket(CONFIG.binance.wsUrl);

        this.ws.on('open', () => {
            console.log('✅ Connected to Binance WebSocket');
            this.reconnectAttempts = 0;

            // Send ping every 30 seconds to keep connection alive
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.ping();
                }
            }, 30000);
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const trade = JSON.parse(data.toString());
                const tick: PriceTick = {
                    price: parseFloat(trade.p),
                    quantity: parseFloat(trade.q),
                    timestamp: trade.T,
                };
                this.processTick(tick);
            } catch (err) {
                // Silently ignore parse errors
            }
        });

        this.ws.on('pong', () => {
            // Connection is alive
        });

        this.ws.on('close', () => {
            if (this.isRunning) {
                this.reconnect();
            }
        });

        this.ws.on('error', (err: Error) => {
            // Only log occasionally to avoid spam
            if (this.reconnectAttempts % 10 === 0) {
                console.error('❌ Binance WebSocket error:', err.message);
            }
        });
    }

    private reconnect(): void {
        this.reconnectAttempts++;

        // After too many WS failures, switch to REST polling
        if (this.reconnectAttempts >= this.WS_MAX_ATTEMPTS && !this.usingRestFallback) {
            console.log('⚠️  WebSocket unavailable — switching to REST polling (1s interval)');
            this.usingRestFallback = true;
            this.startRestPolling();
            return;
        }

        if (!this.usingRestFallback) {
            // Fast backoff: 1s, 2s, 3s, 4s, 5s — then stays at 5s
            const delay = Math.min(1000 * this.reconnectAttempts, 5000);
            if (this.reconnectAttempts % 5 === 1) {
                console.log(`🔄 Reconnecting to Binance (attempt ${this.reconnectAttempts})...`);
            }
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }
    }

    private startRestPolling(): void {
        if (this.restPollInterval) return;
        this.restPollInterval = setInterval(() => this.pollRestPrice(), 1000);
        // Fetch immediately
        this.pollRestPrice();
    }

    private pollRestPrice(): void {
        if (!this.isRunning) return;
        const url = `${CONFIG.binance.restUrl}/ticker/price?symbol=BTCUSDT`;
        https.get(url, (res) => {
            let d = '';
            res.on('data', (c: string) => d += c);
            res.on('end', () => {
                try {
                    const { price } = JSON.parse(d);
                    const tick: PriceTick = {
                        price: parseFloat(price),
                        quantity: 0,
                        timestamp: Date.now(),
                    };
                    this.processTick(tick);
                } catch { }
            });
        }).on('error', () => { });
    }

    private processTick(tick: PriceTick): void {
        this.latestPrice = tick.price;
        this.prices.push(tick);

        // Trim history
        if (this.prices.length > this.MAX_HISTORY) {
            this.prices = this.prices.slice(-this.MAX_HISTORY);
        }

        // Aggregate 1-second closes
        const currentSecond = Math.floor(tick.timestamp / 1000);
        if (currentSecond !== this.lastSecondTimestamp) {
            if (this.currentSecondPrices.length > 0) {
                const close = this.currentSecondPrices[this.currentSecondPrices.length - 1];
                this.closes1s.push(close);

                // Update RSI
                if (this.closes1s.length >= 2) {
                    const change = close - this.closes1s[this.closes1s.length - 2];
                    if (change >= 0) {
                        this.gains.push(change);
                        this.losses.push(0);
                    } else {
                        this.gains.push(0);
                        this.losses.push(Math.abs(change));
                    }
                    // Keep only last 14 for RSI
                    if (this.gains.length > 14) this.gains.shift();
                    if (this.losses.length > 14) this.losses.shift();
                }

                if (this.closes1s.length > this.MAX_1S_CLOSES) {
                    this.closes1s = this.closes1s.slice(-this.MAX_1S_CLOSES);
                }
            }
            this.currentSecondPrices = [];
            this.lastSecondTimestamp = currentSecond;
        }
        this.currentSecondPrices.push(tick.price);

        // Update momentum data
        this.updateMomentum(tick);

        // Emit events
        this.emit('tick', tick);
        this.emit('momentum', this.momentum);
    }

    private updateMomentum(tick: PriceTick): void {
        const now = tick.timestamp;

        // Price changes over different timeframes
        const price1sAgo = this.getPriceAtTime(now - 1000);
        const price5sAgo = this.getPriceAtTime(now - 5000);
        const price15sAgo = this.getPriceAtTime(now - 15000);
        const price60sAgo = this.getPriceAtTime(now - 60000);

        const priceChange1s = price1sAgo ? tick.price - price1sAgo : 0;
        const priceChange5s = price5sAgo ? tick.price - price5sAgo : 0;
        const priceChange15s = price15sAgo ? tick.price - price15sAgo : 0;
        const priceChange60s = price60sAgo ? tick.price - price60sAgo : 0;

        // Velocity: dollars per second (over last 5 seconds)
        const velocity = price5sAgo ? (tick.price - price5sAgo) / 5 : 0;

        // Acceleration: change in velocity
        const prevVelocity = this.momentum.velocity;
        const acceleration = velocity - prevVelocity;

        // Volume in last 1 second
        const volume1s = this.prices
            .filter(p => p.timestamp >= now - 1000)
            .reduce((sum, p) => sum + p.price * p.quantity, 0);

        // RSI calculation
        let rsi14 = 50;
        if (this.gains.length >= 14) {
            const avgGain = this.gains.reduce((a, b) => a + b, 0) / 14;
            const avgLoss = this.losses.reduce((a, b) => a + b, 0) / 14;
            if (avgLoss === 0) {
                rsi14 = 100;
            } else {
                const rs = avgGain / avgLoss;
                rsi14 = 100 - (100 / (1 + rs));
            }
        }

        // Determine trend
        let trend: MomentumData['trend'] = 'NEUTRAL';
        if (priceChange5s > 30 && velocity > 5) trend = 'STRONG_UP';
        else if (priceChange5s > 10 && velocity > 2) trend = 'UP';
        else if (priceChange5s < -30 && velocity < -5) trend = 'STRONG_DOWN';
        else if (priceChange5s < -10 && velocity < -2) trend = 'DOWN';

        this.momentum = {
            currentPrice: tick.price,
            priceChange1s,
            priceChange5s,
            priceChange15s,
            priceChange60s,
            velocity,
            acceleration,
            volume1s,
            rsi14,
            trend,
        };
    }

    private getPriceAtTime(targetTime: number): number | null {
        // Binary search for closest price to target time
        if (this.prices.length === 0) return null;

        let left = 0;
        let right = this.prices.length - 1;

        if (this.prices[left].timestamp > targetTime) return null;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.prices[mid].timestamp < targetTime) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        // Return closest price
        if (left > 0) {
            const diffLeft = Math.abs(this.prices[left - 1].timestamp - targetTime);
            const diffRight = Math.abs(this.prices[left].timestamp - targetTime);
            return diffLeft < diffRight ? this.prices[left - 1].price : this.prices[left].price;
        }
        return this.prices[left].price;
    }

    // Get recent price history as array for chart/analysis
    getRecentPrices(seconds: number): { time: number; price: number }[] {
        const cutoff = Date.now() - seconds * 1000;
        return this.prices
            .filter(p => p.timestamp >= cutoff)
            .map(p => ({ time: p.timestamp, price: p.price }));
    }
}
