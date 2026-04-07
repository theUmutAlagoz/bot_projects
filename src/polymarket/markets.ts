import https from 'https';
import { CONFIG } from '../config';

export interface PolymarketEvent {
    id: string;
    slug: string;
    title: string;
    description?: string;
    active: boolean;
    closed: boolean;
    markets: PolymarketMarket[];
}

export interface PolymarketMarket {
    id: string;
    question: string;
    description?: string;
    slug: string;
    conditionId: string;
    outcomes: string;
    outcomePrices: string;
    active: boolean;
    closed: boolean;
    clobTokenIds: string;
    endDate: string;
    startDate: string;
    volume: string;
    enableOrderBook: boolean;
    orderPriceMinTickSize: number;
    negRisk: boolean;
    acceptingOrders: boolean;
    // Populated from event-level data when available
    startPrice?: number;
}

export interface OrderBookSide {
    price: number;
    size: number;
}

export interface ParsedMarket {
    id: string;
    question: string;
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    // Mid prices from Gamma API (approximate)
    upPrice: number;
    downPrice: number;
    // Real order book best bid/ask from CLOB API
    upBid: number;   // Best bid for UP (what you get if you sell UP)
    upAsk: number;   // Best ask for UP (what you pay to buy UP)
    downBid: number;
    downAsk: number;
    endDate: Date;
    startDate: Date;
    tickSize: string;
    negRisk: boolean;
    acceptingOrders: boolean;
    timeRemainingMs: number;
    volume: number;
    startPrice: number | null;  // BTC target price extracted from Polymarket data
}

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : require('http');
        client.get(url, (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

export class PolymarketMarkets {
    private gammaApi = CONFIG.gammaApi;

    /**
     * Fetch currently active BTC 5-minute markets.
     * 
     * KEY INSIGHT: These markets use a predictable slug pattern:
     *   btc-updown-5m-{unix_timestamp}
     * 
     * Where the timestamp is the START of the 5-minute window,
     * rounded to the nearest 300 seconds (5 minutes).
     * 
     * We calculate which slots are currently active and fetch them directly.
     */
    async fetchBTC5MinMarkets(): Promise<ParsedMarket[]> {
        const now = Math.floor(Date.now() / 1000);
        const FIVE_MIN = 300;

        // Calculate the current 5-minute slot and surrounding slots
        const currentSlot = Math.floor(now / FIVE_MIN) * FIVE_MIN;

        // Fetch current slot, previous slot (might still be resolving),
        // and next slot (might already be accepting orders)
        const slugs = [
            `btc-updown-5m-${currentSlot - FIVE_MIN}`,  // Previous (might still be open)
            `btc-updown-5m-${currentSlot}`,              // Current active
            `btc-updown-5m-${currentSlot + FIVE_MIN}`,   // Next upcoming
        ];

        const allMarkets: ParsedMarket[] = [];

        // Fetch all slots in parallel
        const promises = slugs.map(async (slug) => {
            try {
                const url = `${this.gammaApi}/events?slug=${slug}`;
                const data = await httpGet(url);
                const events: PolymarketEvent[] = JSON.parse(data);

                if (events.length > 0 && events[0].markets) {
                    const event = events[0];
                    for (const market of event.markets) {
                        if (market.active && !market.closed && market.acceptingOrders) {
                            // Combine all text sources for price extraction
                            const allText = [event.title, event.description, market.question, market.description]
                                .filter(Boolean).join(' ');
                            const parsed = this.parseMarket(market, allText);
                            if (parsed && parsed.timeRemainingMs > 0) {
                                allMarkets.push(parsed);
                            }
                        }
                    }
                }
            } catch (error) {
                // Silently skip failed slug
            }
        });

        await Promise.all(promises);

        // Sort by end date (soonest ending first = most urgent to trade)
        allMarkets.sort((a, b) => a.endDate.getTime() - b.endDate.getTime());

        if (allMarkets.length > 0) {
            console.log(`🔍 Found ${allMarkets.length} active BTC 5-min market(s)`);
        }

        return allMarkets;
    }

    /**
     * Get the current actively tradeable market (the one ending soonest
     * that still has enough time to enter a trade).
     */
    async getCurrentMarket(): Promise<ParsedMarket | null> {
        const markets = await this.fetchBTC5MinMarkets();

        // Find the best market to trade:
        // - Has at least 10 seconds remaining (enough to fill an order)
        // - Is still accepting orders
        for (const market of markets) {
            if (market.timeRemainingMs > 10000 && market.acceptingOrders) {
                return market;
            }
        }

        return null;
    }

    /**
     * Try to extract a BTC target price from any text string.
     * Matches "$83,500" or "$83500" style amounts between $10,000 and $999,999.
     */
    private extractTargetPrice(text: string): number | null {
        const matches = text.matchAll(/\$([0-9]{4,6}(?:,[0-9]{3})*(?:\.[0-9]+)?)/g);
        for (const m of matches) {
            const price = parseFloat(m[1].replace(/,/g, ''));
            if (price >= 10000 && price <= 999999) return price;
        }
        return null;
    }

    private parseMarket(market: PolymarketMarket, allText?: string): ParsedMarket | null {
        try {
            if (!market.clobTokenIds || !market.outcomePrices || !market.outcomes) {
                return null;
            }

            const outcomes: string[] = JSON.parse(market.outcomes);
            const prices: string[] = JSON.parse(market.outcomePrices);
            const tokenIds: string[] = JSON.parse(market.clobTokenIds);

            if (outcomes.length < 2 || tokenIds.length < 2) return null;

            // Find Up and Down indices
            let upIndex = outcomes.findIndex(o =>
                o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
            );
            let downIndex = outcomes.findIndex(o =>
                o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
            );

            if (upIndex === -1) upIndex = 0;
            if (downIndex === -1) downIndex = 1;

            const endDate = new Date(market.endDate);

            // The slug encodes the ACTUAL trading window start time (Unix seconds),
            // e.g. "btc-updown-5m-1773237600" → starts at 1773237600s.
            // market.startDate is the DB creation date — NOT the window start.
            const slugMatch = market.slug?.match(/btc-updown-5m-(\d+)/);
            const startDate = slugMatch
                ? new Date(parseInt(slugMatch[1]) * 1000)
                : new Date(endDate.getTime() - 300000);

            const now = Date.now();

            const upPrice = parseFloat(prices[upIndex]) || 0.5;
            const downPrice = parseFloat(prices[downIndex]) || 0.5;

            return {
                id: market.id,
                question: market.question || allText || 'BTC 5-Min Up/Down',
                startPrice: allText ? this.extractTargetPrice(allText) : null,
                slug: market.slug,
                conditionId: market.conditionId,
                upTokenId: tokenIds[upIndex],
                downTokenId: tokenIds[downIndex],
                upPrice,
                downPrice,
                // Order book fields start at 0 — populated by refreshMarketPrices()
                upBid: 0,
                upAsk: upPrice,
                downBid: 0,
                downAsk: downPrice,
                endDate,
                startDate,
                tickSize: market.orderPriceMinTickSize ?
                    market.orderPriceMinTickSize.toString() : '0.01',
                negRisk: market.negRisk || false,
                acceptingOrders: market.acceptingOrders,
                timeRemainingMs: endDate.getTime() - now,
                volume: parseFloat(market.volume) || 0,
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Refresh mid prices (Gamma API) AND real order book bid/ask (CLOB API) in parallel.
     *
     * Why both?
     *  - Gamma API: fast, gives mid price used for display & rough signal logic
     *  - CLOB API:  gives real best-bid / best-ask so we know the TRUE fill price
     *
     * For live orders we use upAsk / downAsk (what we actually pay to buy).
     */
    async refreshMarketPrices(market: ParsedMarket): Promise<ParsedMarket> {
        market.timeRemainingMs = market.endDate.getTime() - Date.now();

        await Promise.all([
            this.refreshMidPrices(market),
            this.refreshOrderBook(market),
        ]);

        return market;
    }

    private async refreshMidPrices(market: ParsedMarket): Promise<void> {
        try {
            const url = `${this.gammaApi}/markets/${market.id}`;
            const data = await httpGet(url);
            const freshMarket: PolymarketMarket = JSON.parse(data);

            if (freshMarket.outcomePrices) {
                const prices: string[] = JSON.parse(freshMarket.outcomePrices);
                const outcomes: string[] = JSON.parse(freshMarket.outcomes || '["Up","Down"]');

                let upIndex = outcomes.findIndex(o =>
                    o.toLowerCase() === 'up' || o.toLowerCase() === 'yes'
                );
                let downIndex = outcomes.findIndex(o =>
                    o.toLowerCase() === 'down' || o.toLowerCase() === 'no'
                );
                if (upIndex === -1) upIndex = 0;
                if (downIndex === -1) downIndex = 1;

                market.upPrice = parseFloat(prices[upIndex]) || market.upPrice;
                market.downPrice = parseFloat(prices[downIndex]) || market.downPrice;
            }

            market.acceptingOrders = freshMarket.acceptingOrders;
        } catch {
            // keep existing mid prices
        }
    }

    /**
     * Fetch best bid/ask for UP and DOWN tokens from CLOB API.
     *
     * CLOB endpoint: GET /books?token_id=<tokenId>
     * Response: { bids: [{price, size},...], asks: [{price, size},...] }
     * bids are sorted desc (best bid = first), asks asc (best ask = first).
     */
    private async refreshOrderBook(market: ParsedMarket): Promise<void> {
        try {
            const [upBook, downBook] = await Promise.all([
                this.fetchBook(market.upTokenId),
                this.fetchBook(market.downTokenId),
            ]);

            if (upBook) {
                market.upBid = upBook.bestBid;
                market.upAsk = upBook.bestAsk;
            }
            if (downBook) {
                market.downBid = downBook.bestBid;
                market.downAsk = downBook.bestAsk;
            }
        } catch {
            // keep existing order book data
        }
    }

    private async fetchBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number } | null> {
        try {
            const url = `${CONFIG.clobApi}/book?token_id=${tokenId}`;
            const data = await httpGet(url);
            const book = JSON.parse(data);

            // bids sorted descending, asks ascending
            const bestBid = book.bids && book.bids.length > 0
                ? parseFloat(book.bids[0].price)
                : 0;
            const bestAsk = book.asks && book.asks.length > 0
                ? parseFloat(book.asks[0].price)
                : 0;

            return { bestBid, bestAsk };
        } catch {
            return null;
        }
    }

}
