// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import RecommendationsGateway from '../../gateways/rpc/Recommendations.gateway';
import { Empty, Product } from '../../protos/demo';
import ProductCatalogService from '../../services/ProductCatalog.service';
import { metrics } from '../../utils/telemetry/metrics';
import logger from '../../utils/telemetry/logger';

type TResponse = Product[] | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const startTime = Date.now();
      const { productIds = [], sessionId = '', currencyCode = '' } = query;

      logger.info({
        event: 'recommendations_requested',
        sessionId: sessionId as string,
        inputProductCount: Array.isArray(productIds) ? productIds.length : 1,
      }, 'Fetching product recommendations');

      const { productIds: productList } = await RecommendationsGateway.listRecommendations(
        sessionId as string,
        productIds as string[]
      );
      const recommendedProductList = await Promise.all(
        productList.slice(0, 4).map(id => ProductCatalogService.getProduct(id, currencyCode as string))
      );

      const duration = Date.now() - startTime;
      metrics.recommendationRequests.add(1, {
        status: 'success',
      });
      metrics.recommendationsServed.add(recommendedProductList.length, {
        currency: currencyCode as string,
      });

      logger.info({
        event: 'recommendations_served',
        sessionId: sessionId as string,
        recommendationCount: recommendedProductList.length,
        durationMs: duration,
      }, 'Recommendations served successfully');

      return res.status(200).json(recommendedProductList);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
