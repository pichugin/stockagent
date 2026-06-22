import { Chalk } from 'chalk';
import Table from 'cli-table3';
import { WS_SPREAD_NOTE } from '../fx/notes.js';
import { renderTable } from '../table.js';
import type { DashboardRow, DashboardSnapshot } from './snapshot.js';

const HEADERS = ['Symbol', '', 'Close', 'Ccy', 'As of', 'Shares', 'Mkt CAD', 'P&L CAD', 'Signals'];

/**
 * A forced-color chalk instance. We gate color ourselves on `isTty` (see the
 * `color` flag), so chalk should not second-guess us with its own pipe
 * detection — the color paths below are only ever reached when we *want* color.
 */
const chalk = new Chalk({ level: 3 });

function fmtNum(n: number | null, dp = 2): string {
  return n == null ? '—' : n.toFixed(dp);
}

function fmtClock(epochMs: number | null): string {
  if (epochMs == null) return '—';
  // Local HH:MM — compact "as of last close" marker, not a live tick.
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Compact per-symbol signal cell, e.g. "2★ 1n". Plain (no color) variant. */
function signalCellPlain(r: DashboardRow): string {
  const parts: string[] = [];
  if (r.signals.actionable > 0) parts.push(`${r.signals.actionable}★`);
  if (r.signals.notable > 0) parts.push(`${r.signals.notable}n`);
  if (r.signals.info > 0) parts.push(`${r.signals.info}i`);
  return parts.join(' ') || '—';
}

function signalCellColor(r: DashboardRow): string {
  const parts: string[] = [];
  if (r.signals.actionable > 0) parts.push(chalk.red.bold(`${r.signals.actionable}★`));
  if (r.signals.notable > 0) parts.push(chalk.yellow(`${r.signals.notable}n`));
  if (r.signals.info > 0) parts.push(chalk.dim(`${r.signals.info}i`));
  return parts.join(' ') || chalk.dim('—');
}

/** Cells in display order; `color` toggles chalk so the same layout serves both paths. */
function rowCells(r: DashboardRow, color: boolean): string[] {
  const holdMark = r.held ? (color ? chalk.cyan('●') : '●') : (color ? chalk.dim('·') : '·');
  let pnl = fmtNum(r.unrealizedPnlCad);
  if (color && r.unrealizedPnlCad != null) {
    pnl = r.unrealizedPnlCad >= 0 ? chalk.green(pnl) : chalk.red(pnl);
  }
  return [
    r.symbol,
    holdMark,
    fmtNum(r.close),
    r.currency,
    fmtClock(r.closeAsOf),
    r.shares == null ? '—' : String(r.shares),
    fmtNum(r.marketValueCad),
    pnl,
    color ? signalCellColor(r) : signalCellPlain(r),
  ];
}

function headerLines(s: DashboardSnapshot, color: boolean): string[] {
  const dim = (t: string) => (color ? chalk.dim(t) : t);
  const lines: string[] = [];

  const marketTxt = s.marketOpen ? 'OPEN' : 'CLOSED';
  const market = color
    ? s.marketOpen
      ? chalk.green(marketTxt)
      : chalk.yellow(marketTxt)
    : marketTxt;

  lines.push(
    (color ? chalk.bold('StockAgent dashboard') : 'StockAgent dashboard') +
      dim('  ·  prices as of last cached close (not live)'),
  );

  const fx = s.fx
    ? `1 USD = ${s.fx.rate.toFixed(4)} CAD (as of ${s.fx.asOf}${s.fx.stale ? ', ⚠ STALE' : ''})`
    : 'no cached FX rate yet';
  const fxLine = color && s.fx?.stale ? chalk.yellow(fx) : fx;

  const poll = s.lastPoll
    ? new Date(s.lastPoll).toLocaleString()
    : 'never';

  lines.push(`Market: ${market}   FX: ${fxLine}`);
  lines.push(dim(`Last poll: ${poll}`));
  return lines;
}

function footerLines(s: DashboardSnapshot, color: boolean): string[] {
  const dim = (t: string) => (color ? chalk.dim(t) : t);
  const lines: string[] = [];

  if (s.totalCad != null) {
    const total = `${s.totalCad.toFixed(2)} CAD`;
    lines.push(
      `Portfolio value (held, at last close): ${color ? chalk.bold(total) : total}` +
        (s.totalPartial ? '  ⚠ partial (some holdings unpriced)' : ''),
    );
    lines.push(dim(WS_SPREAD_NOTE));
  }

  if (s.recentActionable.length > 0) {
    lines.push('');
    lines.push(color ? chalk.red.bold('Recent actionable signals:') : 'Recent actionable signals:');
    for (const r of s.recentActionable) {
      const head = color ? chalk.red(`★ ${r.symbol} ${r.code}`) : `★ ${r.symbol} ${r.code}`;
      lines.push(`  ${head} — ${r.summary} · signal, not advice.`);
    }
  } else {
    lines.push('');
    lines.push(dim('No active actionable signals.'));
  }
  return lines;
}

/**
 * Render the dashboard to a string. `color`/`fancy` default to a real TTY:
 * fancy uses cli-table3 box-drawing + chalk colors; the plain path uses the
 * dependency-light fixed-width table and no ANSI, so piping to a file stays
 * readable (Phase-5 honesty + graceful non-TTY degradation).
 */
export function renderDashboard(
  s: DashboardSnapshot,
  opts: { color?: boolean; fancy?: boolean } = {},
): string {
  const color = opts.color ?? false;
  const fancy = opts.fancy ?? color;

  const head = headerLines(s, color).join('\n');
  const foot = footerLines(s, color).join('\n');

  let body: string;
  if (fancy) {
    const table = new Table({ head: HEADERS, style: { head: [], border: [] } });
    for (const r of s.rows) table.push(rowCells(r, color));
    body = table.toString();
  } else {
    body = renderTable(
      HEADERS,
      s.rows.map((r) => rowCells(r, false)),
    );
  }

  return [head, '', body, foot].join('\n');
}
