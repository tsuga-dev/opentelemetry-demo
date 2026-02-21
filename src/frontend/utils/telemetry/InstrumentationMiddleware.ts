// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import {context, Exception, Span, SpanStatusCode, trace} from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { metrics } from './metrics';
import logger from './logger';

const meter = otelMetrics.getMeter('frontend');
const requestCounter = meter.createCounter('app.frontend.requests');

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const {method, url = ''} = request;
    const [target] = url.split('?');
    const endpoint = target || '/';

    const span = trace.getSpan(context.active()) as Span;
    const startTime = Date.now();

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      httpStatus = 500;

      metrics.apiErrors.add(1, {
        endpoint,
        error_type: error instanceof Error ? error.name : 'unknown',
      });
      logger.error({
        event: 'api_request_failed',
        endpoint,
        method,
        status: httpStatus,
        error: error instanceof Error ? error.message : String(error),
      }, 'API request failed');
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      metrics.apiDuration.record(duration, {
        endpoint,
        method,
        status: httpStatus >= 400 ? 'error' : 'success',
      });
      requestCounter.add(1, { method, target, status: httpStatus });
      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, httpStatus);
    }
  };
};

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return await context.with(ctx, fn);
}

export default InstrumentationMiddleware;
