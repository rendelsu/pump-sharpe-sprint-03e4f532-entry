// Sharpe Sprint paper bot: small, steady momentum scalps on pump.fun bonding curves.
//
// The goal is a high hourly Sharpe ratio, not a moonshot: many small round trips that each
// finish quickly, so the equity curve climbs in small even steps and drawdown stays shallow.
// Every decision is deterministic (no clock, no randomness): the same batch stream always
// produces the same orders.
//
// Entry: a coin qualifies when its spot price (virtual SOL reserve / virtual token reserve)
// has fallen at least 23% from its recent peak over the last LOOKBACK observations, the
// latest step turns back up, and its real SOL reserve is at least 2 SOL deep so the
// per-reply size cap allows a full stake. The stake is a fixed 0.05 SOL, never more than
// the cap, and a coin is bought at most once.
//
// Exit: sell the whole position when the mark value versus cost reaches the take-profit
// band, the stop-loss band, or a time stop (held too long without progress). Positions on
// completed curves are closed by the harness itself.
//
// Risk limits: at most the hello caps' open positions, at most the per-batch order cap,
// and a buy is only sent when free cash covers stake plus transaction fees.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';

const STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per round trip
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the guardrail round-trip floor
const LOOKBACK = 8; // price observations kept per coin
const MOMENTUM_BPS = 600n; // +6% over the lookback window
const TAKE_PROFIT_BPS = 1500n; // exit at +15% mark vs cost
const STOP_LOSS_BPS = -400n; // exit at -4% mark vs cost
const TIME_STOP_BATCHES = 200; // sell after this many batches held
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500;

// Per-coin memory: recent spot prices (scaled), recent trade direction tally, entry batch.
const history = new Map();
const heldSince = new Map();
const traded = new Set();

function priceOf(curve) {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (curve.virtual_quote_reserves * 1000000000000n) / curve.virtual_token_reserves;
}

function observe(state, batch) {
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined) continue;
    let h = history.get(e.mint);
    if (h === undefined) {
      h = { prices: [], buys: 0, sells: 0 };
      history.set(e.mint, h);
    }
    h.prices.push(priceOf(curve));
    if (h.prices.length > LOOKBACK) h.prices.shift();
    if (e.is_buy) h.buys += 1;
    else h.sells += 1;
  }
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.side === 'buy') heldSince.set(f.mint, state.seq);
    if (f.status === 'filled' && f.side === 'sell') heldSince.delete(f.mint);
  }
}

function markBps(state, mint, holding) {
  const curve = state.curves.get(mint);
  if (curve === undefined || holding.cost_lamports === 0n) return 0n;
  const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  return ((value - holding.cost_lamports) * 10000n) / holding.cost_lamports;
}

await runBot({
  onBatch(state, batch) {
    observe(state, batch);
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    const orders = [];
    let free = state.freeCashLamports();

    // Exits first: free the position slots before considering new entries.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const bps = markBps(state, mint, holding);
      const since = heldSince.get(mint);
      const held = since === undefined ? 0 : state.seq - since;
      if (bps >= TAKE_PROFIT_BPS || bps <= STOP_LOSS_BPS || held >= TIME_STOP_BATCHES) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        free -= tx;
      }
    }

    // Entries: momentum with net buy pressure, one stake per coin, slots permitting.
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (e.event !== 'TradeEvent' || traded.has(e.mint)) continue;
      if (state.positions.has(e.mint)) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const h = history.get(e.mint);
      if (h === undefined || h.prices.length < LOOKBACK) continue;
      let peak = 0n;
      for (const p of h.prices) if (p > peak) peak = p;
      const last = h.prices[h.prices.length - 1];
      const prev = h.prices[h.prices.length - 2];
      if (peak === 0n) continue;
      const dip = ((peak - last) * 10000n) / peak;
      if (dip < 2300n) continue;
      if (last <= prev) continue;
      if (curve.real_quote_reserves < LAMPORTS_PER_SOL * 2n) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      traded.add(e.mint);
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
