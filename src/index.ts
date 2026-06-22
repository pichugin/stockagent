#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { registerStart } from './commands/start.js';
import { registerBars } from './commands/bars.js';
import { registerStatus } from './commands/status.js';
import { registerPortfolio } from './commands/portfolio.js';
import { errMsg } from './util.js';

const program = new Command();

program
  .name('stockagent')
  .description('Personal stock monitoring agent — market-data polling, storage & portfolio.')
  .version('0.1.0');

registerStart(program);
registerBars(program);
registerStatus(program);
registerPortfolio(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`stockagent: ${errMsg(err)}`);
  process.exit(1);
});
