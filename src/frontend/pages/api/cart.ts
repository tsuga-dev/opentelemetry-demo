// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiHandler } from 'next';
import CartGateway from '../../gateways/rpc/Cart.gateway';
import { AddItemRequest, Empty } from '../../protos/demo';
import ProductCatalogService from '../../services/ProductCatalog.service';
import { IProductCart, IProductCartItem } from '../../types/Cart';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import { metrics } from '../../utils/telemetry/metrics';
import logger from '../../utils/telemetry/logger';

type TResponse = IProductCart | Empty;

const handler: NextApiHandler<TResponse> = async ({ method, body, query }, res) => {
  const startTime = Date.now();

  switch (method) {
    case 'GET': {
      const { sessionId = '', currencyCode = '' } = query;

      logger.info({
        event: 'cart_view_requested',
        sessionId: sessionId as string,
        currency: currencyCode as string,
      }, 'Cart view requested');

      const { userId, items } = await CartGateway.getCart(sessionId as string);

      const productList: IProductCartItem[] = await Promise.all(
        items.map(async ({ productId, quantity }) => {
          const product = await ProductCatalogService.getProduct(productId, currencyCode as string);

          return {
            productId,
            quantity,
            product,
          };
        })
      );

      const duration = Date.now() - startTime;
      metrics.cartOperationsTotal.add(1, { operation: 'view' });

      logger.info({
        event: 'cart_retrieved',
        userId,
        itemCount: items.length,
        durationMs: duration,
      }, 'Cart retrieved successfully');

      return res.status(200).json({ userId, items: productList });
    }

    case 'POST': {
      const { userId, item } = body as AddItemRequest;

      logger.info({
        event: 'cart_item_add_requested',
        userId,
        productId: item?.productId,
        quantity: item?.quantity,
      }, 'Adding item to cart');

      await CartGateway.addItem(userId, item!);
      const cart = await CartGateway.getCart(userId);

      const duration = Date.now() - startTime;
      metrics.cartOperationsTotal.add(1, { operation: 'add' });
      metrics.cartItemsAdded.add(item?.quantity || 1, {
        productId: item?.productId || 'unknown',
      });

      logger.info({
        event: 'cart_item_added',
        userId,
        productId: item?.productId,
        quantity: item?.quantity,
        cartItemCount: cart.items.length,
        durationMs: duration,
      }, 'Item added to cart successfully');

      return res.status(200).json(cart);
    }

    case 'DELETE': {
      const { userId } = body as AddItemRequest;

      logger.info({
        event: 'cart_clear_requested',
        userId,
      }, 'Clearing cart');

      await CartGateway.emptyCart(userId);

      const duration = Date.now() - startTime;
      metrics.cartOperationsTotal.add(1, { operation: 'empty' });
      metrics.cartCleared.add(1, {
        userId,
      });

      logger.info({
        event: 'cart_cleared',
        userId,
        durationMs: duration,
      }, 'Cart cleared successfully');

      return res.status(204).send('');
    }

    default: {
      logger.warn({
        event: 'cart_invalid_method',
        method,
      }, 'Invalid cart operation method');
      return res.status(405);
    }
  }
};

export default InstrumentationMiddleware(handler);
