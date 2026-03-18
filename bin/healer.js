#!/usr/bin/env node
import { runOnce, startDaemon } from '../src/healer.js';
const once = process.argv.includes('--once');
if (once) runOnce();
else startDaemon();
