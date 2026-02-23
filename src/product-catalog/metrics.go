// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

type ProductCatalogMetrics struct {
	// Business Metrics
	ProductViewsTotal      metric.Int64Counter
	ProductSearchesTotal   metric.Int64Counter
	ProductCatalogOpsTotal metric.Int64Counter
	CatalogSize            metric.Int64ObservableGauge

	// Database Performance Metrics
	DBQueryDuration     metric.Float64Histogram
	DBQueryRowsReturned metric.Int64Histogram
	DBErrorsTotal       metric.Int64Counter

	// Feature Flag Metrics
	FeatureFlagEvaluations metric.Int64Counter
}

func initCatalogMetrics() *ProductCatalogMetrics {
	meter := otel.Meter("product-catalog")

	productViewsTotal, _ := meter.Int64Counter(
		"product_catalog.views.total",
		metric.WithDescription("Total number of product views"),
		metric.WithUnit("{views}"),
	)

	productSearchesTotal, _ := meter.Int64Counter(
		"product_catalog.searches.total",
		metric.WithDescription("Total number of product searches"),
		metric.WithUnit("{searches}"),
	)

	productCatalogOpsTotal, _ := meter.Int64Counter(
		"product_catalog.operations.total",
		metric.WithDescription("Total catalog operations by type"),
		metric.WithUnit("{operations}"),
	)

	catalogSize, _ := meter.Int64ObservableGauge(
		"product_catalog.size",
		metric.WithDescription("Total products in catalog"),
		metric.WithUnit("{products}"),
	)

	dbQueryDuration, _ := meter.Float64Histogram(
		"product_catalog.db.query.duration",
		metric.WithDescription("Database query duration"),
		metric.WithUnit("s"),
	)

	dbQueryRowsReturned, _ := meter.Int64Histogram(
		"product_catalog.db.rows.returned",
		metric.WithDescription("Number of rows returned by database queries"),
		metric.WithUnit("{rows}"),
	)

	dbErrorsTotal, _ := meter.Int64Counter(
		"product_catalog.db.errors.total",
		metric.WithDescription("Total database errors by type"),
		metric.WithUnit("{errors}"),
	)

	featureFlagEvaluations, _ := meter.Int64Counter(
		"product_catalog.feature.flag.evaluations.total",
		metric.WithDescription("Feature flag evaluations count"),
		metric.WithUnit("{evaluations}"),
	)

	return &ProductCatalogMetrics{
		ProductViewsTotal:      productViewsTotal,
		ProductSearchesTotal:   productSearchesTotal,
		ProductCatalogOpsTotal: productCatalogOpsTotal,
		CatalogSize:            catalogSize,
		DBQueryDuration:        dbQueryDuration,
		DBQueryRowsReturned:    dbQueryRowsReturned,
		DBErrorsTotal:          dbErrorsTotal,
		FeatureFlagEvaluations: featureFlagEvaluations,
	}
}
