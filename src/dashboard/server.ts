import express from 'express';
import path from 'path';
import { CONFIG } from '../config';
import { TradeLogger } from '../tracker/trade-logger';
import { BinancePriceFeed } from '../binance/price-feed';

import { ParsedMarket } from '../polymarket/markets';

let globalLogger: TradeLogger;
let globalPriceFeed: BinancePriceFeed;
let globalCurrentMarket: ParsedMarket | null = null;

export function updateDashboardMarket(market: ParsedMarket | null): void {
    globalCurrentMarket = market;
}

export function startDashboard(logger: TradeLogger, priceFeed: BinancePriceFeed): void {
    globalLogger = logger;
    globalPriceFeed = priceFeed;

    const app = express();
    const port = CONFIG.dashboard.port;

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));

    // API endpoints
    app.get('/api/status', (req, res) => {
        const stats = logger.getTodayStats();
        const momentum = priceFeed.momentum;
        const riskCheck = logger.shouldStopTrading();

        const balance = logger.getBalance();
        const startingBalance = logger.getStartingBalance();
        res.json({
            mode: CONFIG.mode,
            btcPrice: momentum.currentPrice,
            momentum: {
                trend: momentum.trend,
                velocity: momentum.velocity,
                priceChange5s: momentum.priceChange5s,
                priceChange15s: momentum.priceChange15s,
                priceChange60s: momentum.priceChange60s,
                rsi14: momentum.rsi14,
            },
            stats,
            balance,
            startingBalance,
            balanceChangePct: startingBalance > 0 ? ((balance - startingBalance) / startingBalance * 100) : 0,
            pendingCount: logger.getPendingTrades().length,
            riskCheck,
            uptime: process.uptime(),
        });
    });

    app.get('/api/trades', (req, res) => {
        const count = parseInt(req.query.count as string) || 50;
        res.json(logger.getRecentTrades(count));
    });

    app.get('/api/prices', (req, res) => {
        const seconds = parseInt(req.query.seconds as string) || 300;
        res.json(priceFeed.getRecentPrices(seconds));
    });

    // Current market with real bid/ask data
    app.get('/api/market', (req, res) => {
        if (!globalCurrentMarket) {
            res.json(null);
            return;
        }
        const m = globalCurrentMarket;
        res.json({
            question: m.question,
            timeRemainingMs: m.timeRemainingMs,
            acceptingOrders: m.acceptingOrders,
            up: {
                mid: m.upPrice,
                bid: m.upBid,
                ask: m.upAsk,
                spread: m.upAsk > 0 && m.upBid > 0 ? +(m.upAsk - m.upBid).toFixed(3) : null,
            },
            down: {
                mid: m.downPrice,
                bid: m.downBid,
                ask: m.downAsk,
                spread: m.downAsk > 0 && m.downBid > 0 ? +(m.downAsk - m.downBid).toFixed(3) : null,
            },
        });
    });

    // Dashboard HTML (served inline for simplicity)
    app.get('/', (req, res) => {
        res.send(getDashboardHTML());
    });

    app.listen(port, () => {
        console.log(`📊 Dashboard running at http://localhost:${port}`);
    });
}

function getDashboardHTML(): string {
    return `<!DOCTYPE html>
<!-- DASHBOARD v3 -->
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Polymarket BTC Bot</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #080910;
            --bg2: #0f1018;
            --bg3: #161825;
            --border: #1e2035;
            --green: #00e676;
            --red: #ff4757;
            --blue: #448aff;
            --purple: #b388ff;
            --orange: #ffab40;
            --text: #e2e4f0;
            --muted: #7c7f9c;
            --dim: #3a3d56;
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }

        /* ── HEADER ── */
        .header {
            display:flex; justify-content:space-between; align-items:center;
            padding:14px 24px;
            background:rgba(8,9,16,0.95);
            border-bottom:1px solid var(--border);
            position:sticky; top:0; z-index:100;
            backdrop-filter:blur(12px);
        }
        .header-left { display:flex; align-items:center; gap:12px; }
        .logo { font-size:18px; font-weight:800; color:var(--blue); letter-spacing:-0.5px; }
        .mode-badge {
            padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;
            text-transform:uppercase; letter-spacing:0.5px;
        }
        .mode-preview { background:rgba(68,138,255,0.15); color:var(--blue); border:1px solid rgba(68,138,255,0.3); }
        .mode-live { background:rgba(0,230,118,0.15); color:var(--green); border:1px solid rgba(0,230,118,0.3); animation:pulse 2s infinite; }
        @keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(0,230,118,0.4)} 50%{box-shadow:0 0 0 6px rgba(0,230,118,0)} }

        .header-right { display:flex; align-items:center; gap:24px; }
        .header-metric { text-align:right; }
        .header-metric .label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; }
        .header-metric .val { font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:700; }
        .dot { width:7px; height:7px; border-radius:50%; background:var(--green); animation:blink 1.2s infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }

        /* ── MAIN LAYOUT ── */
        .main { max-width:1400px; margin:0 auto; padding:20px 24px; }

        /* ── MARKET CARD ── */
        .market-card {
            background:var(--bg2); border:1px solid var(--border); border-radius:16px;
            padding:18px 22px; margin-bottom:18px;
        }
        .market-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px; }
        .market-question { font-size:14px; font-weight:600; color:var(--text); max-width:600px; line-height:1.4; }
        .market-status { font-size:11px; color:var(--muted); margin-top:3px; }

        .countdown-area { text-align:right; }
        .countdown-time {
            font-family:'JetBrains Mono',monospace; font-size:36px; font-weight:700;
            color:var(--text); line-height:1;
        }
        .countdown-time.urgent { color:var(--orange); }
        .countdown-time.critical { color:var(--red); animation:flashRed 0.5s infinite; }
        @keyframes flashRed { 0%,100%{opacity:1} 50%{opacity:0.5} }
        .countdown-label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-top:2px; }

        .progress-wrap { position:relative; height:8px; background:rgba(255,255,255,0.04); border-radius:4px; overflow:hidden; }
        .progress-bar {
            height:100%; border-radius:4px;
            background:linear-gradient(90deg, var(--blue), var(--purple));
            transition:width 0.15s linear, background 0.3s;
        }
        .progress-bar.urgent { background:linear-gradient(90deg, var(--orange), #ff6b00); }
        .progress-bar.critical { background:linear-gradient(90deg, var(--red), #ff0040); }

        .orderbook-row {
            display:flex; gap:10px; margin-top:14px;
        }
        .ob-box {
            flex:1; background:var(--bg3); border:1px solid var(--border); border-radius:10px;
            padding:10px 14px; display:flex; justify-content:space-between; align-items:center;
        }
        .ob-side { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; }
        .ob-up .ob-side { color:var(--green); }
        .ob-down .ob-side { color:var(--red); }
        .ob-prices { font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:600; }
        .ob-spread { font-size:10px; color:var(--muted); margin-top:2px; text-align:right; }

        /* ── STATS GRID ── */
        .stats-grid {
            display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:18px;
        }
        @media(max-width:900px){ .stats-grid{grid-template-columns:repeat(3,1fr);} }
        @media(max-width:600px){ .stats-grid{grid-template-columns:repeat(2,1fr);} }

        .stat-card {
            background:var(--bg2); border:1px solid var(--border); border-radius:12px;
            padding:14px 16px; position:relative; overflow:hidden;
        }
        .stat-card::after {
            content:''; position:absolute; top:0; left:0; right:0; height:2px;
        }
        .stat-card.green::after { background:var(--green); }
        .stat-card.red::after { background:var(--red); }
        .stat-card.blue::after { background:var(--blue); }
        .stat-card.purple::after { background:var(--purple); }
        .stat-card.orange::after { background:var(--orange); }

        .stat-label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
        .stat-value { font-family:'JetBrains Mono',monospace; font-size:22px; font-weight:700; }
        .stat-sub { font-size:11px; color:var(--muted); margin-top:4px; }
        .pos { color:var(--green); }
        .neg { color:var(--red); }
        .neu { color:var(--muted); }

        /* ── MOMENTUM BAR ── */
        .momentum-bar {
            background:var(--bg2); border:1px solid var(--border); border-radius:12px;
            padding:12px 18px; display:flex; gap:20px; flex-wrap:wrap;
            align-items:center; margin-bottom:18px;
        }
        .m-item .label { font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:0.5px; }
        .m-item .value { font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:600; margin-top:2px; }
        .trend-badge { padding:3px 10px; border-radius:6px; font-size:12px; font-weight:700; font-family:'JetBrains Mono',monospace; }
        .t-su { background:rgba(0,230,118,0.15); color:var(--green); }
        .t-u  { background:rgba(0,200,83,0.1);  color:#69f0ae; }
        .t-n  { background:rgba(255,255,255,0.05); color:var(--muted); }
        .t-d  { background:rgba(255,71,87,0.1);  color:#ff8a80; }
        .t-sd { background:rgba(255,71,87,0.15); color:var(--red); }

        /* ── CHART ── */
        .chart-wrap {
            background:var(--bg2); border:1px solid var(--border); border-radius:12px;
            padding:16px; margin-bottom:18px; height:180px; position:relative;
        }

        /* ── STRATEGY ROW ── */
        .strategy-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:18px; }
        @media(max-width:600px){ .strategy-row{grid-template-columns:1fr;} }

        /* ── SECTION TITLE ── */
        .section-title { font-size:13px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; }

        /* ── TRADES TABLE ── */
        .trades-wrap { background:var(--bg2); border:1px solid var(--border); border-radius:12px; overflow:hidden; margin-bottom:24px; }
        .trades-table { width:100%; border-collapse:collapse; }
        .trades-table th {
            background:var(--bg3); padding:10px 14px; text-align:left;
            font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; font-weight:600;
        }
        .trades-table td { padding:9px 14px; border-top:1px solid rgba(30,32,53,0.8); font-size:12px; font-family:'JetBrains Mono',monospace; }
        .trades-table tr:hover td { background:rgba(68,138,255,0.03); }

        .badge { padding:2px 8px; border-radius:5px; font-size:10px; font-weight:700; }
        .b-up { background:rgba(0,230,118,0.15); color:var(--green); }
        .b-down { background:rgba(255,71,87,0.15); color:var(--red); }
        .b-won { background:rgba(0,230,118,0.15); color:var(--green); }
        .b-lost { background:rgba(255,71,87,0.15); color:var(--red); }
        .b-pending { background:rgba(68,138,255,0.15); color:var(--blue); }
        .b-contrarian { background:rgba(179,136,255,0.15); color:var(--purple); }
        .b-sniper { background:rgba(255,171,64,0.15); color:var(--orange); }

        .no-data { text-align:center; padding:32px; color:var(--dim); font-size:13px; font-family:'Inter',sans-serif; }
    </style>
</head>
<body>
    <!-- HEADER -->
    <div class="header">
        <div class="header-left">
            <div class="logo">🤖 Polymarket BTC Bot</div>
            <span class="mode-badge mode-preview" id="modeBadge">PREVIEW</span>
            <div class="dot"></div>
        </div>
        <div class="header-right">
            <div class="header-metric">
                <div class="label">BTC (Binance)</div>
                <div class="val" id="btcPrice">$---</div>
            </div>
            <div style="width:1px;height:36px;background:var(--border)"></div>
            <div class="header-metric">
                <div class="label">Bakiye</div>
                <div class="val pos" id="balanceVal">$20.00</div>
                <div style="font-size:10px;text-align:right;margin-top:1px" id="balanceChange"></div>
            </div>
        </div>
    </div>

    <div class="main">

        <!-- ACTIVE MARKET CARD -->
        <div class="market-card" id="marketCard">
            <div class="market-top">
                <div>
                    <div class="market-question" id="marketQuestion">Market bekleniyor...</div>
                    <div class="market-status" id="marketStatus">Polymarket'e bağlanıyor</div>
                </div>
                <div class="countdown-area">
                    <div class="countdown-time" id="countdownTime">5:00</div>
                    <div class="countdown-label">kalan süre</div>
                </div>
            </div>
            <div class="progress-wrap">
                <div class="progress-bar" id="progressBar" style="width:100%"></div>
            </div>
            <div class="orderbook-row">
                <div class="ob-box ob-up">
                    <div>
                        <div class="ob-side">UP ↑</div>
                        <div class="ob-prices" id="upBook">-- / --</div>
                        <div class="ob-spread" id="upSpread">spread: --</div>
                    </div>
                    <div style="font-size:22px;opacity:0.2">⬆</div>
                </div>
                <div class="ob-box ob-down">
                    <div>
                        <div class="ob-side">DOWN ↓</div>
                        <div class="ob-prices" id="downBook">-- / --</div>
                        <div class="ob-spread" id="downSpread">spread: --</div>
                    </div>
                    <div style="font-size:22px;opacity:0.2">⬇</div>
                </div>
            </div>
        </div>

        <!-- STATS GRID -->
        <div class="stats-grid">
            <div class="stat-card green">
                <div class="stat-label">Toplam P&L</div>
                <div class="stat-value" id="totalPnl">$0.00</div>
                <div class="stat-sub" id="roiSub">ROI: 0%</div>
            </div>
            <div class="stat-card blue">
                <div class="stat-label">Kazanma Oranı</div>
                <div class="stat-value" id="winRate">0%</div>
                <div class="stat-sub" id="winsSub">0K / 0K</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">Toplam Trade</div>
                <div class="stat-value" id="totalTrades">0</div>
                <div class="stat-sub" id="pendingSub">0 bekliyor</div>
            </div>
            <div class="stat-card blue">
                <div class="stat-label">En İyi Trade</div>
                <div class="stat-value pos" id="bestTrade">$0.00</div>
            </div>
            <div class="stat-card red">
                <div class="stat-label">En Kötü Trade</div>
                <div class="stat-value neg" id="worstTrade">$0.00</div>
            </div>
            <div class="stat-card orange">
                <div class="stat-label">Ort. Güven</div>
                <div class="stat-value" id="avgConf">0%</div>
            </div>
        </div>

        <!-- MOMENTUM -->
        <div class="section-title">BTC Momentum</div>
        <div class="momentum-bar">
            <div class="m-item">
                <div class="label">Trend</div>
                <div style="margin-top:3px"><span class="trend-badge t-n" id="trendBadge">NEUTRAL</span></div>
            </div>
            <div class="m-item">
                <div class="label">Hız</div>
                <div class="value" id="velocity">$0/s</div>
            </div>
            <div class="m-item">
                <div class="label">Δ5s</div>
                <div class="value" id="change5s">$0</div>
            </div>
            <div class="m-item">
                <div class="label">Δ15s</div>
                <div class="value" id="change15s">$0</div>
            </div>
            <div class="m-item">
                <div class="label">Δ60s</div>
                <div class="value" id="change60s">$0</div>
            </div>
            <div class="m-item">
                <div class="label">RSI (14)</div>
                <div class="value" id="rsi">50</div>
            </div>
        </div>

        <!-- CHART -->
        <div class="section-title">BTC Fiyat (5 dk)</div>
        <div class="chart-wrap">
            <canvas id="priceChart" style="width:100%;height:100%"></canvas>
        </div>

        <!-- STRATEGY PERFORMANCE -->
        <div class="section-title">Strateji Performansı</div>
        <div class="strategy-row">
            <div class="stat-card purple">
                <div class="stat-label">🔄 Contrarian (Ortalamaya Dönüş)</div>
                <div class="stat-value" id="momentumPnl">$0.00</div>
                <div class="stat-sub" id="momentumSub">0 trade, 0 kazanç</div>
            </div>
            <div class="stat-card orange">
                <div class="stat-label">🎯 Sniper (Son Saniye)</div>
                <div class="stat-value" id="sniperPnl">$0.00</div>
                <div class="stat-sub" id="sniperSub">0 trade, 0 kazanç</div>
            </div>
        </div>

        <!-- RECENT TRADES -->
        <div class="section-title">Son Tradeler</div>
        <div class="trades-wrap">
            <table class="trades-table">
                <thead>
                    <tr>
                        <th>ID</th><th>Saat</th><th>Yön</th><th>Strateji</th>
                        <th>Güven</th><th>Giriş</th><th>Boyut</th><th>BTC</th>
                        <th>Durum</th><th>P&L</th>
                    </tr>
                </thead>
                <tbody id="tradesBody">
                    <tr><td colspan="10" class="no-data">Henüz trade yok — bot fırsat arıyor...</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <script>
        // ── State ──
        let lastMarketFetchTime = 0;
        let lastMarketTimeRemainingMs = 300000;
        let prevBalance = null;

        // ── Smooth countdown (100ms tick) ──
        setInterval(() => {
            if (!lastMarketFetchTime) return;
            const elapsed = Date.now() - lastMarketFetchTime;
            const remaining = Math.max(0, lastMarketTimeRemainingMs - elapsed);
            const totalMs = 300000;
            const pct = remaining / totalMs * 100;

            const totalSecs = Math.ceil(remaining / 1000);
            const mins = Math.floor(totalSecs / 60);
            const secs = totalSecs % 60;
            const timeStr = mins + ':' + secs.toString().padStart(2, '0');

            const el = document.getElementById('countdownTime');
            const bar = document.getElementById('progressBar');
            if (remaining < 30000) {
                el.className = 'countdown-time critical';
                bar.className = 'progress-bar critical';
            } else if (remaining < 90000) {
                el.className = 'countdown-time urgent';
                bar.className = 'progress-bar urgent';
            } else {
                el.className = 'countdown-time';
                bar.className = 'progress-bar';
            }
            el.textContent = totalSecs <= 0 ? '0:00' : timeStr;
            bar.style.width = Math.max(0, pct) + '%';
        }, 100);

        // ── API Fetchers ──
        async function fetchStatus() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                updateStatus(d);
            } catch(e) {}
        }

        async function fetchTrades() {
            try {
                const r = await fetch('/api/trades?count=30');
                const t = await r.json();
                updateTrades(t);
            } catch(e) {}
        }

        async function fetchPrices() {
            try {
                const r = await fetch('/api/prices?seconds=300');
                const p = await r.json();
                drawChart(p);
            } catch(e) {}
        }

        async function fetchMarket() {
            try {
                const r = await fetch('/api/market');
                const m = await r.json();
                if (!m) { document.getElementById('marketQuestion').textContent = 'Market bekleniyor...'; return; }
                lastMarketFetchTime = Date.now();
                lastMarketTimeRemainingMs = m.timeRemainingMs;
                document.getElementById('marketQuestion').textContent = m.question;
                document.getElementById('marketStatus').textContent = m.acceptingOrders ? 'Emirler kabul ediliyor' : 'Emirler kabul edilmiyor';
                const fmt = v => v > 0 ? (v*100).toFixed(1) + '¢' : '--';
                document.getElementById('upBook').textContent = fmt(m.up.bid) + ' bid / ' + fmt(m.up.ask) + ' ask';
                document.getElementById('downBook').textContent = fmt(m.down.bid) + ' bid / ' + fmt(m.down.ask) + ' ask';
                document.getElementById('upSpread').textContent = m.up.spread != null ? 'spread: ' + (m.up.spread*100).toFixed(1) + '¢' : 'spread: --';
                document.getElementById('downSpread').textContent = m.down.spread != null ? 'spread: ' + (m.down.spread*100).toFixed(1) + '¢' : 'spread: --';
            } catch(e) {}
        }

        function updateStatus(d) {
            // Mode
            const badge = document.getElementById('modeBadge');
            badge.textContent = d.mode.toUpperCase();
            badge.className = 'mode-badge mode-' + d.mode;

            // BTC price
            const btcEl = document.getElementById('btcPrice');
            btcEl.textContent = d.btcPrice > 0 ? '$' + d.btcPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '$---';

            // Balance
            const balEl = document.getElementById('balanceVal');
            const balChg = document.getElementById('balanceChange');
            balEl.textContent = '$' + d.balance.toFixed(2);
            balEl.className = 'val ' + (d.balance >= d.startingBalance ? 'pos' : 'neg');
            const chgPct = d.balanceChangePct;
            balChg.textContent = (chgPct >= 0 ? '+' : '') + chgPct.toFixed(1) + '%';
            balChg.style.color = chgPct >= 0 ? 'var(--green)' : 'var(--red)';

            // Stats
            const s = d.stats;
            const pnlEl = document.getElementById('totalPnl');
            pnlEl.textContent = (s.totalPnl >= 0 ? '+' : '') + '$' + s.totalPnl.toFixed(2);
            pnlEl.className = 'stat-value ' + (s.totalPnl >= 0 ? 'pos' : 'neg');
            document.getElementById('roiSub').textContent = 'ROI: ' + s.roi.toFixed(1) + '%';
            document.getElementById('winRate').textContent = s.winRate.toFixed(0) + '%';
            document.getElementById('winsSub').textContent = s.wins + 'K / ' + s.losses + 'K';
            document.getElementById('totalTrades').textContent = s.totalTrades;
            document.getElementById('pendingSub').textContent = d.pendingCount + ' bekliyor';
            document.getElementById('bestTrade').textContent = '+$' + s.bestTrade.toFixed(2);
            document.getElementById('worstTrade').textContent = '$' + s.worstTrade.toFixed(2);
            document.getElementById('avgConf').textContent = (s.avgConfidence * 100).toFixed(0) + '%';

            // Momentum
            const m = d.momentum;
            const trendMap = { STRONG_UP:'t-su', UP:'t-u', NEUTRAL:'t-n', DOWN:'t-d', STRONG_DOWN:'t-sd' };
            const trendEl = document.getElementById('trendBadge');
            trendEl.className = 'trend-badge ' + (trendMap[m.trend] || 't-n');
            trendEl.textContent = m.trend.replace('_',' ');

            const velEl = document.getElementById('velocity');
            velEl.textContent = '$' + m.velocity.toFixed(1) + '/s';
            velEl.className = 'value ' + (m.velocity > 0 ? 'pos' : m.velocity < 0 ? 'neg' : 'neu');

            function colorChange(id, val) {
                const el = document.getElementById(id);
                el.textContent = (val >= 0 ? '+' : '') + '$' + val.toFixed(0);
                el.className = 'value ' + (val > 0 ? 'pos' : val < 0 ? 'neg' : 'neu');
            }
            colorChange('change5s', m.priceChange5s);
            colorChange('change15s', m.priceChange15s);
            colorChange('change60s', m.priceChange60s);

            const rsiEl = document.getElementById('rsi');
            rsiEl.textContent = m.rsi14.toFixed(0);
            rsiEl.className = 'value ' + (m.rsi14 > 70 ? 'neg' : m.rsi14 < 30 ? 'pos' : 'neu');

            // Strategy
            const sp = s.strategies;
            const mPnl = document.getElementById('momentumPnl');
            mPnl.textContent = (sp.momentum.pnl >= 0 ? '+' : '') + '$' + sp.momentum.pnl.toFixed(2);
            mPnl.className = 'stat-value ' + (sp.momentum.pnl >= 0 ? 'pos' : 'neg');
            document.getElementById('momentumSub').textContent = sp.momentum.trades + ' trade, ' + sp.momentum.wins + ' kazanç';

            const sPnl = document.getElementById('sniperPnl');
            sPnl.textContent = (sp.sniper.pnl >= 0 ? '+' : '') + '$' + sp.sniper.pnl.toFixed(2);
            sPnl.className = 'stat-value ' + (sp.sniper.pnl >= 0 ? 'pos' : 'neg');
            document.getElementById('sniperSub').textContent = sp.sniper.trades + ' trade, ' + sp.sniper.wins + ' kazanç';
        }

        function updateTrades(trades) {
            const tbody = document.getElementById('tradesBody');
            if (!trades.length) {
                tbody.innerHTML = '<tr><td colspan="10" class="no-data">Henüz trade yok — bot fırsat arıyor...</td></tr>';
                return;
            }
            tbody.innerHTML = [...trades].reverse().map(t => {
                const time = new Date(t.timestamp).toLocaleTimeString('tr-TR');
                const stratClass = t.strategy === 'sniper' ? 'b-sniper' : 'b-contrarian';
                const statusClass = 'b-' + t.status;
                const dirClass = t.side === 'UP' ? 'b-up' : 'b-down';
                const pnlClass = t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : 'neu';
                const statusLabel = t.status === 'won' ? 'KAZANDI' : t.status === 'lost' ? 'KAYBETTİ' : t.status === 'pending' ? 'BEKLIYOR' : t.status.toUpperCase();
                return '<tr>'
                    + '<td style="color:var(--muted)">' + t.id + '</td>'
                    + '<td>' + time + '</td>'
                    + '<td><span class="badge ' + dirClass + '">' + t.side + '</span></td>'
                    + '<td><span class="badge ' + stratClass + '">' + t.strategy.toUpperCase() + '</span></td>'
                    + '<td>' + (t.confidence*100).toFixed(0) + '%</td>'
                    + '<td>' + (t.entryPrice*100).toFixed(1) + '¢</td>'
                    + '<td>$' + t.size.toFixed(2) + '</td>'
                    + '<td>$' + t.btcPriceAtEntry.toFixed(0) + '</td>'
                    + '<td><span class="badge ' + statusClass + '">' + statusLabel + '</span></td>'
                    + '<td class="' + pnlClass + '">' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2) + '</td>'
                    + '</tr>';
            }).join('');
        }

        function drawChart(prices) {
            const canvas = document.getElementById('priceChart');
            const ctx = canvas.getContext('2d');
            const rect = canvas.parentElement.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            const W = rect.width, H = rect.height;
            ctx.clearRect(0, 0, W, H);

            if (prices.length < 2) {
                ctx.fillStyle = '#3a3d56'; ctx.font = '13px Inter'; ctx.textAlign = 'center';
                ctx.fillText('Fiyat verisi bekleniyor...', W/2, H/2);
                return;
            }

            const step = Math.max(1, Math.floor(prices.length / 400));
            const sampled = prices.filter((_,i) => i % step === 0);
            const vals = sampled.map(p => p.price);
            const minP = Math.min(...vals), maxP = Math.max(...vals);
            const range = maxP - minP || 1;
            const pad = { t:15, b:20, l:8, r:64 };
            const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;

            const last = vals[vals.length-1], first = vals[0];
            const up = last >= first;
            const col = up ? '#00e676' : '#ff4757';

            // fill
            const grad = ctx.createLinearGradient(0, pad.t, 0, H-pad.b);
            grad.addColorStop(0, up ? 'rgba(0,230,118,0.12)' : 'rgba(255,71,87,0.12)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            sampled.forEach((p,i) => {
                const x = pad.l + (i/(sampled.length-1))*cW;
                const y = pad.t + (1-(p.price-minP)/range)*cH;
                i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
            });
            const lx = pad.l+cW, ly = pad.t+(1-(sampled[sampled.length-1].price-minP)/range)*cH;
            ctx.lineTo(lx, H-pad.b); ctx.lineTo(pad.l, H-pad.b);
            ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

            // line
            ctx.beginPath();
            sampled.forEach((p,i) => {
                const x = pad.l + (i/(sampled.length-1))*cW;
                const y = pad.t + (1-(p.price-minP)/range)*cH;
                i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
            });
            ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();

            // dot
            ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI*2); ctx.fillStyle = col; ctx.fill();

            // labels
            ctx.fillStyle = '#5c5f7a'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'right';
            ctx.fillText('$'+maxP.toFixed(0), W-4, pad.t+10);
            ctx.fillText('$'+minP.toFixed(0), W-4, H-pad.b-4);
            ctx.fillStyle = col;
            ctx.fillText('$'+last.toFixed(0), W-4, Math.min(H-pad.b-4, Math.max(pad.t+10, ly+4)));
        }

        // ── Start ──
        fetchStatus(); fetchTrades(); fetchPrices(); fetchMarket();
        setInterval(fetchStatus, 1000);
        setInterval(fetchTrades, 2000);
        setInterval(fetchPrices, 5000);
        setInterval(fetchMarket, 2000);
    </script>
</body>
</html>`;
}
