// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

const { metrics } = require('@opentelemetry/api');

const meter = metrics.getMeter('payment');

// Business Metrics
const paymentAttemptsTotal = meter.createCounter('payment.attempts.total', {
  description: 'Total number of payment attempts',
  unit: '{attempts}',
});

const paymentErrorsTotal = meter.createCounter('payment.errors.total', {
  description: 'Total number of payment errors by type',
  unit: '{errors}',
});

const paymentAmountTotal = meter.createCounter('payment.amount.total', {
  description: 'Total payment amount processed',
  unit: '{currency}',
});

const paymentDuration = meter.createHistogram('payment.processing.duration', {
  description: 'Payment processing duration',
  unit: 's',
});

const paymentGatewayErrors = meter.createCounter('payment.gateway.errors.total', {
  description: 'Payment gateway errors by type',
  unit: '{errors}',
});

const paymentRetries = meter.createCounter('payment.retries.total', {
  description: 'Payment retry attempts',
  unit: '{retries}',
});

const fraudChecks = meter.createCounter('payment.fraud.checks.total', {
  description: 'Fraud detection checks performed',
  unit: '{checks}',
});

// Technical Metrics
const activeConnections = meter.createUpDownCounter('payment.active.connections', {
  description: 'Number of active gRPC connections',
  unit: '{connections}',
});

const featureFlagEvaluations = meter.createCounter('payment.feature.flag.evaluations.total', {
  description: 'Feature flag evaluations count',
  unit: '{evaluations}',
});

module.exports = {
  paymentAttemptsTotal,
  paymentErrorsTotal,
  paymentAmountTotal,
  paymentDuration,
  paymentGatewayErrors,
  paymentRetries,
  fraudChecks,
  activeConnections,
  featureFlagEvaluations,
};
