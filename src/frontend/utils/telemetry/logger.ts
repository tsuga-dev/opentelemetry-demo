// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { trace, context, SpanStatusCode } from '@opentelemetry/api';

export interface LogAttributes {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Logger with automatic trace correlation
 * Extracts trace_id and span_id from active span and includes in logs
 */
class FrontendLogger {
  private getTraceContext() {
    const span = trace.getActiveSpan();
    if (!span) {
      return {};
    }

    const spanContext = span.spanContext();
    return {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      trace_flags: spanContext.traceFlags,
    };
  }

  private log(level: string, attributes: LogAttributes, message: string) {
    const traceContext = this.getTraceContext();
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...traceContext,
      ...attributes,
    };

    // In production, this would be sent to a logging backend
    // For now, we use console with structured format
    if (typeof window !== 'undefined') {
      // Client-side: use console
      const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      consoleMethod(JSON.stringify(logEntry));
    } else {
      // Server-side: log to stdout (captured by container logs)
      console.log(JSON.stringify(logEntry));
    }
  }

  info(attributes: LogAttributes, message: string) {
    this.log('info', attributes, message);
  }

  warn(attributes: LogAttributes, message: string) {
    this.log('warn', attributes, message);
  }

  error(attributes: LogAttributes, message: string) {
    this.log('error', attributes, message);
    
    // Also record exception in active span
    const span = trace.getActiveSpan();
    if (span && attributes?.error) {
      span.recordException(attributes.error as unknown as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    }
  }

  debug(attributes: LogAttributes, message: string) {
    if (process.env.NODE_ENV === 'development') {
      this.log('debug', attributes, message);
    }
  }
}

const logger = new FrontendLogger();
export default logger;
export { logger };
