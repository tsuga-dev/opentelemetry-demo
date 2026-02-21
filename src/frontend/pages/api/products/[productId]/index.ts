// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../../protos/demo';
import ProductCatalogService from '../../../../services/ProductCatalog.service';
import { metrics } from '../../../../utils/telemetry/metrics';
import logger from '../../../../utils/telemetry/logger';

type TResponse = Product | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const startTime = Date.now();
      const { productId = '', currencyCode = '' } = query;

      try {
        logger.info({
          event: 'product_detail_requested',
          productId: productId as string,
          currency: currencyCode as string,
        }, 'Fetching product details');

        const product = await ProductCatalogService.getProduct(productId as string, currencyCode as string);

        const duration = Date.now() - startTime;
        metrics.productViews.add(1, {
          product_id: productId as string,
          currency: currencyCode as string,
        });
        metrics.apiDuration.record(duration, {
          endpoint: '/api/products/[productId]',
          method: 'GET',
          status: 'success',
        });

        logger.info({
          event: 'product_detail_served',
          productId: productId as string,
          productName: product.name,
          currency: currencyCode as string,
          durationMs: duration,
        }, 'Product details served successfully');

        return res.status(200).json(product);
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.apiDuration.record(duration, {
          endpoint: '/api/products/[productId]',
          method: 'GET',
          status: 'error',
        });
        metrics.apiErrors.add(1, {
          endpoint: '/api/products/[productId]',
          error_type: error instanceof Error ? error.name : 'unknown',
        });

        logger.error({
          event: 'product_detail_failed',
          productId: productId as string,
          currency: currencyCode as string,
          error: error instanceof Error ? error.message : String(error),
          durationMs: duration,
        }, 'Failed to fetch product details');

        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
