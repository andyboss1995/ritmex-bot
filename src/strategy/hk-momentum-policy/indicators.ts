export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(values.length - period);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / period;
}

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0]!;
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period: number): number {
  if (values.length <= period) return NaN;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(values: number[], fast: number, slow: number, signalPeriod: number): MacdResult {
  if (values.length < slow + signalPeriod) {
    return { macd: NaN, signal: NaN, histogram: NaN };
  }
  const fastSeries = ema(values, fast);
  const slowSeries = ema(values, slow);
  const macdSeries: number[] = [];
  for (let i = 0; i < values.length; i++) {
    macdSeries.push(fastSeries[i]! - slowSeries[i]!);
  }
  const signalSeries = ema(macdSeries.slice(slow - 1), signalPeriod);
  const macdLast = macdSeries[macdSeries.length - 1]!;
  const signalLast = signalSeries[signalSeries.length - 1]!;
  return { macd: macdLast, signal: signalLast, histogram: macdLast - signalLast };
}

export function highest(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(values.length - period);
  let h = -Infinity;
  for (const v of slice) if (v > h) h = v;
  return h;
}

export function averageVolume(volumes: number[], period: number): number {
  return sma(volumes, period);
}
