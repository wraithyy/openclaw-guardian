#!/usr/bin/env node
import { startProxy }  from '../src/proxy.js';
import { startDaemon } from '../src/healer.js';

startProxy();
startDaemon();
