// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import CheckoutGateway from '../../gateways/rpc/Checkout.gateway';
import { Empty, PlaceOrderRequest } from '../../protos/demo';
import { IProductCheckoutItem, IProductCheckout } from '../../types/Cart';
import ProductCatalogService from '../../services/ProductCatalog.service';
import { metrics } from '../../utils/telemetry/metrics';
import logger from '../../utils/telemetry/logger';

type TResponse = IProductCheckout | Empty;

const handler = async ({ method, body, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'POST': {
      const startTime = Date.now();
      const { currencyCode = '' } = query;
      const orderData = body as PlaceOrderRequest;

      try {
        logger.info({ 
          event: 'checkout_initiated',
          currency: currencyCode as string,
        }, 'Checkout process initiated');

        const { order: { items = [], ...order } = {} } = await CheckoutGateway.placeOrder(orderData);

        const productList: IProductCheckoutItem[] = await Promise.all(
          items.map(async ({ item: { productId = '', quantity = 0 } = {}, cost }) => {
            const product = await ProductCatalogService.getProduct(productId, currencyCode as string);

            return {
              cost,
              item: {
                productId,
                quantity,
                product,
              },
            };
          })
        );

        const duration = Date.now() - startTime;
        metrics.checkoutDuration.record(duration, {
          currency: currencyCode as string,
          status: 'success',
        });
        metrics.checkoutAttempts.add(1, {
          status: 'success',
          currency: currencyCode as string,
        });

        logger.info({
          event: 'checkout_completed',
          orderId: 'orderId' in order ? order.orderId : '',
          currency: currencyCode as string,
          itemCount: productList.length,
          durationMs: duration,
        }, 'Checkout completed successfully');

        return res.status(200).json({ ...order, items: productList });
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.checkoutDuration.record(duration, {
          currency: currencyCode as string,
          status: 'error',
        });
        metrics.checkoutAttempts.add(1, {
          status: 'error',
          currency: currencyCode as string,
        });
        metrics.checkoutErrors.add(1, {
          error_type: error instanceof Error ? error.name : 'unknown',
          currency: currencyCode as string,
        });

        logger.error({
          event: 'checkout_failed',
          error: error instanceof Error ? error.message : String(error),
          currency: currencyCode as string,
          durationMs: duration,
        }, 'Checkout process failed');

        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
