#!/usr/bin/env node
import { startProxy }    from '../src/proxy.js';
import { startDaemon }   from '../src/healer.js';
import { startExporter } from '../src/exporter.js';
import { setLogSink }    from '../src/logger.js';
import { bufferLog }     from '../src/exporter.js';

setLogSink(bufferLog);
startProxy();
startDaemon();
startExporter();
