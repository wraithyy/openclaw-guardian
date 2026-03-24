#!/usr/bin/env node
import { startProxy }    from '../src/proxy.js';
import { startDaemon }   from '../src/healer.js';
import { startExporter } from '../src/exporter.js';
import { setLogSink }    from '../src/logger.js';
import { bufferLog }     from '../src/exporter.js';
import { config }        from '../src/config.js';
import { logger }        from '../src/logger.js';

setLogSink(bufferLog);
startProxy();
startDaemon();
startExporter();

if (config.sessionTracking?.enabled) {
  logger.info('Session tracking enabled', {
    maxSessions: config.sessionTracking.maxTrackedSessions,
    ttlMinutes: config.sessionTracking.sessionTtlMinutes,
  });
}
