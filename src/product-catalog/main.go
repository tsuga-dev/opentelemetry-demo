// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

//go:generate go install google.golang.org/protobuf/cmd/protoc-gen-go
//go:generate go install google.golang.org/grpc/cmd/protoc-gen-go-grpc
//go:generate protoc --go_out=./ --go-grpc_out=./ --proto_path=../../pb ../../pb/demo.proto

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.38.0"
	"go.opentelemetry.io/otel/trace"

	otelhooks "github.com/open-feature/go-sdk-contrib/hooks/open-telemetry/pkg"
	flagd "github.com/open-feature/go-sdk-contrib/providers/flagd/pkg"
	"github.com/open-feature/go-sdk/openfeature"
	pb "github.com/opentelemetry/opentelemetry-demo/src/product-catalog/genproto/oteldemo"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	"github.com/XSAM/otelsql"
)

type productCatalog struct {
	pb.UnimplementedProductCatalogServiceServer
}

var (
	logger            *slog.Logger
	resource          *sdkresource.Resource
	initResourcesOnce sync.Once
	db                *sql.DB
	reg               metric.Registration
	catalogMetrics    *ProductCatalogMetrics
)

func init() {
	logger = otelslog.NewLogger("product-catalog")
}

func initResource() *sdkresource.Resource {
	initResourcesOnce.Do(func() {
		extraResources, _ := sdkresource.New(
			context.Background(),
			sdkresource.WithOS(),
			sdkresource.WithProcess(),
			sdkresource.WithContainer(),
			sdkresource.WithHost(),
		)
		resource, _ = sdkresource.Merge(
			sdkresource.Default(),
			extraResources,
		)
	})
	return resource
}

func initTracerProvider() *sdktrace.TracerProvider {
	ctx := context.Background()

	exporter, err := otlptracegrpc.New(ctx)
	if err != nil {
		logger.Error(fmt.Sprintf("OTLP Trace gRPC Creation: %v", err))

	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(initResource()),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp
}

func initMeterProvider() *sdkmetric.MeterProvider {
	ctx := context.Background()

	exporter, err := otlpmetricgrpc.New(ctx)
	if err != nil {
		logger.Error(fmt.Sprintf("new otlp metric grpc exporter failed: %v", err))
	}

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)),
		sdkmetric.WithResource(initResource()),
	)
	otel.SetMeterProvider(mp)
	return mp
}

func initLoggerProvider() *sdklog.LoggerProvider {
	ctx := context.Background()

	logExporter, err := otlploggrpc.New(ctx)
	if err != nil {
		return nil
	}

	loggerProvider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
	)
	global.SetLoggerProvider(loggerProvider)

	return loggerProvider
}

func initDatabase() error {
	connStr := os.Getenv("DB_CONNECTION_STRING")
	if connStr == "" {
		return fmt.Errorf("DB_CONNECTION_STRING environment variable not set")
	}

	var err error
	db, err = otelsql.Open("postgres", connStr,
		otelsql.WithAttributes(semconv.DBSystemNamePostgreSQL),
		otelsql.WithSpanOptions(otelsql.SpanOptions{
			OmitConnResetSession: true,
			OmitRows:             true,
		}))
	if err != nil {
		return fmt.Errorf("failed to open database connection: %w", err)
	}

	reg, err = otelsql.RegisterDBStatsMetrics(db, otelsql.WithAttributes(semconv.DBSystemNamePostgreSQL))
	if err != nil {
		return fmt.Errorf("failed to register database metrics: %w", err)
	}

	// Test the connection
	if err := db.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	logger.Info("Database connection established")
	return nil
}

func main() {
	lp := initLoggerProvider()
	defer func() {
		if err := lp.Shutdown(context.Background()); err != nil {
			logger.Error(fmt.Sprintf("Logger Provider Shutdown: %v", err))
		}
		logger.Info("Shutdown logger provider")
	}()

	tp := initTracerProvider()
	defer func() {
		if err := tp.Shutdown(context.Background()); err != nil {
			logger.Error(fmt.Sprintf("Tracer Provider Shutdown: %v", err))
		}
		logger.Info("Shutdown tracer provider")
	}()

	mp := initMeterProvider()
	defer func() {
		if err := mp.Shutdown(context.Background()); err != nil {
			logger.Error(fmt.Sprintf("Error shutting down meter provider: %v", err))
		}
		logger.Info("Shutdown meter provider")
	}()

	// Initialize database connection
	if err := initDatabase(); err != nil {
		logger.Error(fmt.Sprintf("Error initializing database: %v", err))
		os.Exit(1)
	}
	defer func() {
		if db != nil {
			if err := db.Close(); err != nil {
				logger.Error(fmt.Sprintf("Error closing database connection: %v", err))
			} else {
				logger.Info("Database connection closed")
			}
		}
		if reg != nil {
			if err := reg.Unregister(); err != nil {
				logger.Error(fmt.Sprintf("Error unregistering database metrics: %v", err))
			} else {
				logger.Info("Database metrics unregistered")
			}
		}
	}()

	openfeature.AddHooks(otelhooks.NewTracesHook())
	provider, err := flagd.NewProvider()
	if err != nil {
		logger.Error(err.Error())
	}
	err = openfeature.SetProvider(provider)
	if err != nil {
		logger.Error(err.Error())
	}

	err = runtime.Start(runtime.WithMinimumReadMemStatsInterval(time.Second))
	if err != nil {
		logger.Error(err.Error())
	}

	// Initialize catalog metrics
	catalogMetrics = initCatalogMetrics()

	svc := &productCatalog{}
	var port string
	mustMapEnv(&port, "PRODUCT_CATALOG_PORT")

	logger.Info(fmt.Sprintf("Product Catalog gRPC server started on port: %s", port))

	ln, err := net.Listen("tcp", fmt.Sprintf(":%s", port))
	if err != nil {
		logger.Error(fmt.Sprintf("TCP Listen: %v", err))
	}

	srv := grpc.NewServer(
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
	)

	reflection.Register(srv)

	pb.RegisterProductCatalogServiceServer(srv, svc)

	healthcheck := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthcheck)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGKILL)
	defer cancel()

	go func() {
		if err := srv.Serve(ln); err != nil {
			logger.Error(fmt.Sprintf("Failed to serve gRPC server, err: %v", err))
		}
	}()

	<-ctx.Done()

	srv.GracefulStop()
	logger.Info("Product Catalog gRPC server stopped")
}

func loadProductsFromDB(ctx context.Context) ([]*pb.Product, error) {
	if db == nil {
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "connection_not_initialized"),
		))
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Track query start time
	startTime := time.Now()

	// Query all products with categories
	rows, err := db.QueryContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		ORDER BY p.id
	`)
	if err != nil {
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "query_failed"),
		))
		logger.LogAttrs(
			ctx,
			slog.LevelError, "Database query failed",
			slog.String("error", err.Error()),
			slog.String("query_type", "list_all_products"),
		)
		return nil, fmt.Errorf("failed to query products: %w", err)
	}
	defer rows.Close()

	products, err := getProductsFromRows(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("failed to get products from rows: %w", err)
	}

	// Record query metrics
	duration := time.Since(startTime).Seconds()
	catalogMetrics.DBQueryDuration.Record(ctx, duration, metric.WithAttributes(
		attribute.String("query_type", "list_all_products"),
	))
	catalogMetrics.DBQueryRowsReturned.Record(ctx, int64(len(products)), metric.WithAttributes(
		attribute.String("query_type", "list_all_products"),
	))

	logger.LogAttrs(
		ctx,
		slog.LevelDebug, "Database query executed",
		slog.String("query_type", "list_all_products"),
		slog.Float64("duration_seconds", duration),
		slog.Int("rows_returned", len(products)),
	)

	return products, nil
}

func searchProductsFromDB(ctx context.Context, query string) ([]*pb.Product, error) {
	if db == nil {
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "connection_not_initialized"),
		))
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Track query start time
	startTime := time.Now()

	// Query products matching search query in name or description
	searchPattern := "%" + strings.ToLower(query) + "%"
	rows, err := db.QueryContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		WHERE LOWER(p.name) LIKE $1 OR LOWER(p.description) LIKE $1
		ORDER BY p.id
	`, searchPattern)
	if err != nil {
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "query_failed"),
		))
		logger.LogAttrs(
			ctx,
			slog.LevelError, "Database search query failed",
			slog.String("error", err.Error()),
			slog.String("query_type", "search_products"),
			slog.String("search_query", query),
		)
		return nil, fmt.Errorf("failed to query products: %w", err)
	}
	defer rows.Close()

	products, err := getProductsFromRows(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("failed to get products from rows: %w", err)
	}

	// Record query metrics
	duration := time.Since(startTime).Seconds()
	catalogMetrics.DBQueryDuration.Record(ctx, duration, metric.WithAttributes(
		attribute.String("query_type", "search_products"),
	))
	catalogMetrics.DBQueryRowsReturned.Record(ctx, int64(len(products)), metric.WithAttributes(
		attribute.String("query_type", "search_products"),
	))

	logger.LogAttrs(
		ctx,
		slog.LevelDebug, "Database search query executed",
		slog.String("query_type", "search_products"),
		slog.String("search_query", query),
		slog.Float64("duration_seconds", duration),
		slog.Int("rows_returned", len(products)),
	)

	return products, nil
}

func getProductFromDB(ctx context.Context, productID string) (*pb.Product, error) {
	if db == nil {
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "connection_not_initialized"),
		))
		return nil, fmt.Errorf("database connection not initialized")
	}

	// Track query start time
	startTime := time.Now()

	// Query single product by ID
	row := db.QueryRowContext(ctx, `
		SELECT p.id, p.name, p.description, p.picture, 
		       p.price_currency_code, p.price_units, p.price_nanos, p.categories
		FROM catalog.products p
		WHERE p.id = $1
	`, productID)

	var id, name, description, picture, currencyCode, categoriesStr string
	var units int64
	var nanos int32

	if err := row.Scan(&id, &name, &description, &picture, &currencyCode, &units, &nanos, &categoriesStr); err != nil {
		if err == sql.ErrNoRows {
			catalogMetrics.DBQueryRowsReturned.Record(ctx, 0, metric.WithAttributes(
				attribute.String("query_type", "get_product_by_id"),
			))
			logger.LogAttrs(
				ctx,
				slog.LevelDebug, "Product not found in database",
				slog.String("product_id", productID),
			)
			return nil, fmt.Errorf("product not found")
		}
		catalogMetrics.DBErrorsTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("error_type", "scan_failed"),
		))
		logger.LogAttrs(
			ctx,
			slog.LevelError, "Failed to scan product row",
			slog.String("error", err.Error()),
			slog.String("product_id", productID),
		)
		return nil, fmt.Errorf("failed to scan product row: %w", err)
	}

	// Record query metrics
	duration := time.Since(startTime).Seconds()
	catalogMetrics.DBQueryDuration.Record(ctx, duration, metric.WithAttributes(
		attribute.String("query_type", "get_product_by_id"),
	))
	catalogMetrics.DBQueryRowsReturned.Record(ctx, 1, metric.WithAttributes(
		attribute.String("query_type", "get_product_by_id"),
	))

	logger.LogAttrs(
		ctx,
		slog.LevelDebug, "Database query executed",
		slog.String("query_type", "get_product_by_id"),
		slog.String("product_id", productID),
		slog.Float64("duration_seconds", duration),
	)

	return parseProductRow(id, name, description, picture, currencyCode, categoriesStr, units, nanos), nil
}

func getProductsFromRows(ctx context.Context, rows *sql.Rows) ([]*pb.Product, error) {
	var products []*pb.Product

	for rows.Next() {
		var id, name, description, picture, currencyCode, categoriesStr string
		var units int64
		var nanos int32

		if err := rows.Scan(&id, &name, &description, &picture, &currencyCode, &units, &nanos, &categoriesStr); err != nil {
			return nil, fmt.Errorf("failed to scan product row: %w", err)
		}

		products = append(products, parseProductRow(id, name, description, picture, currencyCode, categoriesStr, units, nanos))
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating product rows: %w", err)
	}

	logger.LogAttrs(
		ctx,
		slog.LevelInfo,
		fmt.Sprintf("Found %d products from database", len(products)),
		slog.Int("products", len(products)),
	)

	return products, nil
}

func parseProductRow(id, name, description, picture, currencyCode, categoriesStr string, units int64, nanos int32) *pb.Product {
	// Parse comma-delimited categories string into slice
	var categories []string
	if categoriesStr != "" {
		categories = strings.Split(categoriesStr, ",")
		// Trim whitespace from each category
		for i, cat := range categories {
			categories[i] = strings.TrimSpace(cat)
		}
	}

	return &pb.Product{
		Id:          id,
		Name:        name,
		Description: description,
		Picture:     picture,
		PriceUsd: &pb.Money{
			CurrencyCode: currencyCode,
			Units:        units,
			Nanos:        nanos,
		},
		Categories: categories,
	}
}

func mustMapEnv(target *string, key string) {
	value, present := os.LookupEnv(key)
	if !present {
		logger.Error(fmt.Sprintf("Environment Variable Not Set: %q", key))
	}
	*target = value
}

func (p *productCatalog) Check(ctx context.Context, req *healthpb.HealthCheckRequest) (*healthpb.HealthCheckResponse, error) {
	return &healthpb.HealthCheckResponse{Status: healthpb.HealthCheckResponse_SERVING}, nil
}

func (p *productCatalog) Watch(req *healthpb.HealthCheckRequest, ws healthpb.Health_WatchServer) error {
	return status.Errorf(codes.Unimplemented, "health check via Watch not implemented")
}

func (p *productCatalog) ListProducts(ctx context.Context, req *pb.Empty) (*pb.ListProductsResponse, error) {
	span := trace.SpanFromContext(ctx)

	// Track catalog operation
	catalogMetrics.ProductCatalogOpsTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("operation", "list"),
	))

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Listing all products",
	)

	products, err := loadProductsFromDB(ctx)
	if err != nil {
		span.SetStatus(otelcodes.Error, err.Error())
		logger.LogAttrs(
			ctx,
			slog.LevelError, "Failed to load products from database",
			slog.String("error", err.Error()),
		)
		return nil, status.Errorf(codes.Internal, "failed to load products: %v", err)
	}

	span.SetAttributes(
		attribute.Int("app.products.count", len(products)),
	)

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Products listed successfully",
		slog.Int("product_count", len(products)),
	)

	return &pb.ListProductsResponse{Products: products}, nil
}

func (p *productCatalog) GetProduct(ctx context.Context, req *pb.GetProductRequest) (*pb.Product, error) {
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("app.product.id", req.Id),
	)

	// Track catalog operation and product view
	catalogMetrics.ProductCatalogOpsTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("operation", "get"),
	))
	catalogMetrics.ProductViewsTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("product_id", req.Id),
	))

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Product requested",
		slog.String("product_id", req.Id),
	)

	// GetProduct will fail on a specific product when feature flag is enabled
	if p.checkProductFailure(ctx, req.Id) {
		msg := "Error: Product Catalog Fail Feature Flag Enabled"
		span.SetStatus(otelcodes.Error, msg)
		span.AddEvent(msg)

		logger.LogAttrs(
			ctx,
			slog.LevelError, "Product catalog failure triggered by feature flag",
			slog.String("product_id", req.Id),
			slog.String("flag_name", "productCatalogFailure"),
		)

		return nil, status.Errorf(codes.Internal, msg)
	}

	found, err := getProductFromDB(ctx, req.Id)
	if err != nil {
		msg := fmt.Sprintf("Product Not Found: %s", req.Id)
		span.SetStatus(otelcodes.Error, msg)
		span.AddEvent(msg)

		logger.LogAttrs(
			ctx,
			slog.LevelWarn, "Product not found",
			slog.String("product_id", req.Id),
			slog.String("error", err.Error()),
		)

		return nil, status.Errorf(codes.NotFound, msg)
	}

	span.AddEvent("Product Found")
	span.SetAttributes(
		attribute.String("app.product.id", req.Id),
		attribute.String("app.product.name", found.Name),
	)

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Product found and returned",
		slog.String("product_name", found.Name),
		slog.String("product_id", req.Id),
		slog.String("category", found.Categories[0]),
	)

	return found, nil
}

func (p *productCatalog) SearchProducts(ctx context.Context, req *pb.SearchProductsRequest) (*pb.SearchProductsResponse, error) {
	span := trace.SpanFromContext(ctx)

	// Track search operations
	catalogMetrics.ProductCatalogOpsTotal.Add(ctx, 1, metric.WithAttributes(
		attribute.String("operation", "search"),
	))
	catalogMetrics.ProductSearchesTotal.Add(ctx, 1)

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Product search requested",
		slog.String("query", req.Query),
	)

	result, err := searchProductsFromDB(ctx, req.Query)
	if err != nil {
		span.SetStatus(otelcodes.Error, err.Error())
		logger.LogAttrs(
			ctx,
			slog.LevelError, "Product search failed",
			slog.String("query", req.Query),
			slog.String("error", err.Error()),
		)
		return nil, status.Errorf(codes.Internal, "failed to search products: %v", err)
	}

	span.SetAttributes(
		attribute.Int("app.products_search.count", len(result)),
	)

	logger.LogAttrs(
		ctx,
		slog.LevelInfo, "Product search completed",
		slog.String("query", req.Query),
		slog.Int("results_count", len(result)),
	)

	return &pb.SearchProductsResponse{Results: result}, nil
}

func (p *productCatalog) checkProductFailure(ctx context.Context, id string) bool {
	if id != "OLJCESPC7Z" {
		return false
	}

	client := openfeature.NewClient("productCatalog")
	failureEnabled, _ := client.BooleanValue(
		ctx, "productCatalogFailure", false, openfeature.EvaluationContext{},
	)

	// Track feature flag evaluation
	catalogMetrics.FeatureFlagEvaluations.Add(ctx, 1, metric.WithAttributes(
		attribute.String("flag_name", "productCatalogFailure"),
		attribute.Bool("value", failureEnabled),
	))

	if failureEnabled {
		logger.LogAttrs(
			ctx,
			slog.LevelWarn, "Feature flag evaluated: product catalog failure enabled",
			slog.String("flag_name", "productCatalogFailure"),
			slog.String("product_id", id),
			slog.Bool("enabled", failureEnabled),
		)
	}

	return failureEnabled
}
