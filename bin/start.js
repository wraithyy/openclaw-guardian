#!/usr/bin/env node
/**
 * start.js – Launch proxy + healer together.
 */
import { startProxy }  from '../src/proxy.js';
import { startHealer } from '../src/healer.js';

startProxy();
startHealer();
