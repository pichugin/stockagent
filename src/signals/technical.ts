import type { SignalsConfig } from '../config.js';
import type { BarRow } from '../db.js';
import {
  latestBollinger,
  latestMACD,
  latestMACross,
  latestRSI,
  latestSMA,
} from './indicators.js';
import type { ScanResult, Signal } from './types.js';

/** Round to 2 decimals for display-friendly `data` values. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pure technical-signal generator: (ascending bars, config) → Signals. Every
 * summary states what is currently true about the indicator — none predicts.
 *
 * `bars` must be ascending (oldest first). When there isn't even enough history
 * for the smallest indicator (RSI), the symbol gets one `insufficient_data`
 * diagnostic and no signals. Indicators that individually lack history are
 * skipped silently (we compute what the data supports).
 */
export function technicalSignals(
  symbol: string,
  bars: BarRow[],
  cfg: SignalsConfig,
  now: string,
): ScanResult {
  const signals: Signal[] = [];
  const closes = bars.map((b) => b.close);
  const minNeeded = cfg.rsi.period + 1;
  if (closes.length < minNeeded) {
    return {
      signals,
      insufficient: [
        {
          symbol,
          reason: `${closes.length} bar(s) cached, need ≥${minNeeded} for RSI(${cfg.rsi.period})`,
        },
      ],
    };
  }

  const latestClose = closes[closes.length - 1];
  const add = (
    code: string,
    severity: Signal['severity'],
    summary: string,
    data: Signal['data'],
  ): void => {
    signals.push({ symbol, kind: 'technical', code, severity, summary, data, firedAt: now });
  };

  // RSI(period)
  const rsi = latestRSI(closes, cfg.rsi.period);
  if (rsi != null) {
    if (rsi > cfg.rsi.overbought) {
      add(
        'rsi_overbought',
        'notable',
        `RSI(${cfg.rsi.period}) = ${r2(rsi)}, above the ${cfg.rsi.overbought} overbought line`,
        { rsi: r2(rsi), period: cfg.rsi.period, overbought: cfg.rsi.overbought },
      );
    } else if (rsi < cfg.rsi.oversold) {
      add(
        'rsi_oversold',
        'notable',
        `RSI(${cfg.rsi.period}) = ${r2(rsi)}, below the ${cfg.rsi.oversold} oversold line`,
        { rsi: r2(rsi), period: cfg.rsi.period, oversold: cfg.rsi.oversold },
      );
    }
  }

  // MACD signal-line cross
  const macd = latestMACD(closes, cfg.macd.fastPeriod, cfg.macd.slowPeriod, cfg.macd.signalPeriod);
  if (macd?.cross === 'bullish') {
    add(
      'macd_bullish_cross',
      'notable',
      `MACD line crossed above its signal line (MACD ${r2(macd.macd)} > signal ${r2(macd.signal)})`,
      { macd: r2(macd.macd), signal: r2(macd.signal), histogram: r2(macd.histogram) },
    );
  } else if (macd?.cross === 'bearish') {
    add(
      'macd_bearish_cross',
      'notable',
      `MACD line crossed below its signal line (MACD ${r2(macd.macd)} < signal ${r2(macd.signal)})`,
      { macd: r2(macd.macd), signal: r2(macd.signal), histogram: r2(macd.histogram) },
    );
  }

  // Golden / death cross between the short and long SMA
  const ma = latestMACross(closes, cfg.movingAverages.shortPeriod, cfg.movingAverages.longPeriod);
  if (ma?.cross === 'bullish') {
    add(
      'ma_golden_cross',
      'notable',
      `SMA(${cfg.movingAverages.shortPeriod}) crossed above SMA(${cfg.movingAverages.longPeriod}) ` +
        `(${r2(ma.shortMA)} > ${r2(ma.longMA)})`,
      { shortMA: r2(ma.shortMA), longMA: r2(ma.longMA), shortPeriod: cfg.movingAverages.shortPeriod, longPeriod: cfg.movingAverages.longPeriod },
    );
  } else if (ma?.cross === 'bearish') {
    add(
      'ma_death_cross',
      'notable',
      `SMA(${cfg.movingAverages.shortPeriod}) crossed below SMA(${cfg.movingAverages.longPeriod}) ` +
        `(${r2(ma.shortMA)} < ${r2(ma.longMA)})`,
      { shortMA: r2(ma.shortMA), longMA: r2(ma.longMA), shortPeriod: cfg.movingAverages.shortPeriod, longPeriod: cfg.movingAverages.longPeriod },
    );
  }

  // Price relative to the short MA (codes are stable ids for the configured short MA)
  const shortMA = latestSMA(closes, cfg.movingAverages.shortPeriod);
  if (shortMA != null) {
    if (latestClose > shortMA) {
      add(
        'price_above_50ma',
        'info',
        `Latest close ${r2(latestClose)} is above its SMA(${cfg.movingAverages.shortPeriod}) of ${r2(shortMA)}`,
        { close: r2(latestClose), shortMA: r2(shortMA), shortPeriod: cfg.movingAverages.shortPeriod },
      );
    } else {
      add(
        'price_below_50ma',
        'info',
        `Latest close ${r2(latestClose)} is below its SMA(${cfg.movingAverages.shortPeriod}) of ${r2(shortMA)}`,
        { close: r2(latestClose), shortMA: r2(shortMA), shortPeriod: cfg.movingAverages.shortPeriod },
      );
    }
  }

  // Bollinger Bands(period, stdDev) breaches
  const bb = latestBollinger(closes, cfg.bollinger.period, cfg.bollinger.stdDev);
  if (bb) {
    if (latestClose < bb.lower) {
      add(
        'price_below_lower_band',
        'notable',
        `Latest close ${r2(latestClose)} is below the lower Bollinger band ${r2(bb.lower)} ` +
          `(${cfg.bollinger.period}, ${cfg.bollinger.stdDev}σ)`,
        { close: r2(latestClose), lower: r2(bb.lower), middle: r2(bb.middle), upper: r2(bb.upper) },
      );
    } else if (latestClose > bb.upper) {
      add(
        'price_above_upper_band',
        'notable',
        `Latest close ${r2(latestClose)} is above the upper Bollinger band ${r2(bb.upper)} ` +
          `(${cfg.bollinger.period}, ${cfg.bollinger.stdDev}σ)`,
        { close: r2(latestClose), lower: r2(bb.lower), middle: r2(bb.middle), upper: r2(bb.upper) },
      );
    }
  }

  return { signals, insufficient: [] };
}
