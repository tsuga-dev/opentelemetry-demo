// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../protos/demo';
import ProductCatalogService from '../../../services/ProductCatalog.service';
import { metrics } from '../../../utils/telemetry/metrics';
import logger from '../../../utils/telemetry/logger';

type TResponse = Product[] | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const startTime = Date.now();
      const { currencyCode = '' } = query;

      logger.info({
        event: 'product_list_requested',
        currency: currencyCode as string,
      }, 'Fetching product catalog');

      const productList = await ProductCatalogService.listProducts(currencyCode as string);

      const duration = Date.now() - startTime;
      metrics.productCatalogViews.add(1, {
        currency: currencyCode as string,
      });

      logger.info({
        event: 'product_list_served',
        productCount: productList.length,
        currency: currencyCode as string,
        durationMs: duration,
      }, 'Product catalog served successfully');

      return res.status(200).json(productList);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
