// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { metrics as metricsApi } from '@opentelemetry/api';

const meter = metricsApi.getMeter('frontend');

// User Experience Metrics (RUM)
export const pageViewsTotal = meter.createCounter('frontend.page.views.total', {
  description: 'Total number of page views',
  unit: '{views}',
});

export const userInteractionsTotal = meter.createCounter('frontend.user.interactions.total', {
  description: 'Total number of user interactions',
  unit: '{interactions}',
});

export const clientErrorsTotal = meter.createCounter('frontend.errors.total', {
  description: 'Total number of client-side errors',
  unit: '{errors}',
});

export const apiCallDuration = meter.createHistogram('frontend.api.call.duration', {
  description: 'API call duration from client',
  unit: 's',
});

// Business Metrics
export const cartOperationsTotal = meter.createCounter('frontend.cart.operations.total', {
  description: 'Total cart operations',
  unit: '{operations}',
});

export const productInteractionsTotal = meter.createCounter('frontend.product.interactions.total', {
  description: 'Total product interactions',
  unit: '{interactions}',
});

export const checkoutFunnelTotal = meter.createCounter('frontend.checkout.funnel.total', {
  description: 'Checkout funnel stage progression',
  unit: '{events}',
});

export const searchQueriesTotal = meter.createCounter('frontend.search.queries.total', {
  description: 'Total search queries',
  unit: '{queries}',
});

// Performance Metrics  
export const componentRenderDuration = meter.createHistogram('frontend.component.render.duration', {
  description: 'Component render duration',
  unit: 'ms',
});

// API Server-side Metrics
const checkoutAttempts = meter.createCounter('frontend.checkout.attempts.total', {
  description: 'Total checkout attempts by status and currency',
  unit: '{attempts}',
});

const checkoutErrors = meter.createCounter('frontend.checkout.errors.total', {
  description: 'Checkout errors by type',
  unit: '{errors}',
});

const checkoutDuration = meter.createHistogram('frontend.checkout.duration', {
  description: 'Checkout processing duration',
  unit: 'ms',
});

const recommendationRequests = meter.createCounter('frontend.recommendation.requests.total', {
  description: 'Total recommendation requests',
  unit: '{requests}',
});

const recommendationsServed = meter.createCounter('frontend.recommendations.served.total', {
  description: 'Total recommendations served',
  unit: '{recommendations}',
});

const shippingQuotes = meter.createCounter('frontend.shipping.quotes.total', {
  description: 'Shipping quote requests',
  unit: '{quotes}',
});

const adsServed = meter.createCounter('frontend.ads.served.total', {
  description: 'Total ads served',
  unit: '{ads}',
});

const productViews = meter.createCounter('frontend.product.views.total', {
  description: 'Product detail views',
  unit: '{views}',
});

const productCatalogViews = meter.createCounter('frontend.product.catalog.views.total', {
  description: 'Product catalog list views',
  unit: '{views}',
});

const apiDuration = meter.createHistogram('frontend.api.duration', {
  description: 'API endpoint duration',
  unit: 'ms',
});

const apiErrors = meter.createCounter('frontend.api.errors.total', {
  description: 'API endpoint errors',
  unit: '{errors}',
});

const cartItemsAdded = meter.createCounter('frontend.cart.items.added.total', {
  description: 'Cart items added',
  unit: '{items}',
});

const cartItemsRemoved = meter.createCounter('frontend.cart.items.removed.total', {
  description: 'Cart items removed',
  unit: '{items}',
});

const cartCleared = meter.createCounter('frontend.cart.cleared.total', {
  description: 'Cart clear operations',
  unit: '{operations}',
});

export const metrics = {
  // Client-side metrics
  pageViewsTotal,
  userInteractionsTotal,
  clientErrorsTotal,
  apiCallDuration,
  cartOperationsTotal,
  productInteractionsTotal,
  checkoutFunnelTotal,
  searchQueriesTotal,
  componentRenderDuration,
  
  // Server-side API metrics
  checkoutAttempts,
  checkoutErrors,
  checkoutDuration,
  recommendationRequests,
  recommendationsServed,
  shippingQuotes,
  adsServed,
  productViews,
  productCatalogViews,
  apiDuration,
  apiErrors,
  cartItemsAdded,
  cartItemsRemoved,
  cartCleared,
};
