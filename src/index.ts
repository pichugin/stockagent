#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { registerStart } from './commands/start.js';
import { registerDashboard } from './commands/dashboard.js';
import { registerBars } from './commands/bars.js';
import { registerStatus } from './commands/status.js';
import { registerPortfolio } from './commands/portfolio.js';
import { registerFx } from './commands/fx.js';
import { registerScan } from './commands/scan.js';
import { registerSignals } from './commands/signals.js';
import { registerAlert } from './commands/alert.js';
import { errMsg } from './util.js';

const program = new Command();

program
  .name('stockagent')
  .description('Personal stock monitoring agent — polling, storage, portfolio, FX & signals.')
  .version('0.1.0');

registerStart(program);
registerDashboard(program);
registerBars(program);
registerStatus(program);
registerPortfolio(program);
registerFx(program);
registerScan(program);
registerSignals(program);
registerAlert(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`stockagent: ${errMsg(err)}`);
  process.exit(1);
});
