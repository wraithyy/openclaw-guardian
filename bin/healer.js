#!/usr/bin/env node
/**
 * bin/healer.js – Start only the session healer.
 *   --once  → single scan then exit
 */
import { startDaemon, runOnce } from '../src/healer.js';

if (process.argv.includes('--once')) {
  runOnce().then(() => {
    console.log('[guardian] Single scan complete.');
    process.exit(0);
  });
} else {
  startDaemon();
}
