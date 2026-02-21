// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

type CheckoutMetrics struct {
	// Business Metrics
	CheckoutAttemptsTotal  metric.Int64Counter
	CheckoutErrorsTotal    metric.Int64Counter
	OrderValueTotal        metric.Float64Counter
	CheckoutDuration       metric.Float64Histogram
	ItemsPerOrder          metric.Int64Histogram
	ActiveCheckoutSessions metric.Int64UpDownCounter

	// Technical Metrics
	GRPCCallsTotal         metric.Int64Counter
	KafkaPublishDuration   metric.Float64Histogram
	FeatureFlagEvaluations metric.Int64Counter
}

func initMetrics() *CheckoutMetrics {
	meter := otel.Meter("checkout")

	checkoutAttemptsTotal, _ := meter.Int64Counter(
		"checkout.attempts.total",
		metric.WithDescription("Total number of checkout attempts"),
		metric.WithUnit("{attempts}"),
	)

	checkoutErrorsTotal, _ := meter.Int64Counter(
		"checkout.errors.total",
		metric.WithDescription("Total number of checkout errors by type"),
		metric.WithUnit("{errors}"),
	)

	orderValueTotal, _ := meter.Float64Counter(
		"checkout.order.value.total",
		metric.WithDescription("Total order value processed"),
		metric.WithUnit("{currency}"),
	)

	checkoutDuration, _ := meter.Float64Histogram(
		"checkout.duration",
		metric.WithDescription("Checkout processing duration"),
		metric.WithUnit("s"),
	)

	itemsPerOrder, _ := meter.Int64Histogram(
		"checkout.items.per.order",
		metric.WithDescription("Distribution of items per order"),
		metric.WithUnit("{items}"),
	)

	activeCheckoutSessions, _ := meter.Int64UpDownCounter(
		"checkout.active.sessions",
		metric.WithDescription("Number of active checkout sessions"),
		metric.WithUnit("{sessions}"),
	)

	grpcCallsTotal, _ := meter.Int64Counter(
		"checkout.grpc.calls.total",
		metric.WithDescription("Total gRPC calls to downstream services"),
		metric.WithUnit("{calls}"),
	)

	kafkaPublishDuration, _ := meter.Float64Histogram(
		"checkout.kafka.publish.duration",
		metric.WithDescription("Kafka message publish latency"),
		metric.WithUnit("s"),
	)

	featureFlagEvaluations, _ := meter.Int64Counter(
		"checkout.feature.flag.evaluations.total",
		metric.WithDescription("Feature flag evaluations count"),
		metric.WithUnit("{evaluations}"),
	)

	return &CheckoutMetrics{
		CheckoutAttemptsTotal:  checkoutAttemptsTotal,
		CheckoutErrorsTotal:    checkoutErrorsTotal,
		OrderValueTotal:        orderValueTotal,
		CheckoutDuration:       checkoutDuration,
		ItemsPerOrder:          itemsPerOrder,
		ActiveCheckoutSessions: activeCheckoutSessions,
		GRPCCallsTotal:         grpcCallsTotal,
		KafkaPublishDuration:   kafkaPublishDuration,
		FeatureFlagEvaluations: featureFlagEvaluations,
	}
}
