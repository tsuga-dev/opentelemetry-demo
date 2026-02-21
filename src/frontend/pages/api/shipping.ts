// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import ShippingGateway from '../../gateways/http/Shipping.gateway';
import { Address, CartItem, Empty, Money } from '../../protos/demo';
import CurrencyGateway from '../../gateways/rpc/Currency.gateway';
import { metrics } from '../../utils/telemetry/metrics';
import logger from '../../utils/telemetry/logger';

type TResponse = Money | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const startTime = Date.now();
      const { itemList = '', currencyCode = 'USD', address = '' } = query;

      try {
        const items = JSON.parse(itemList as string) as CartItem[];
        const parsedAddress = JSON.parse(address as string) as Address;

        logger.info({
          event: 'shipping_quote_requested',
          itemCount: items.length,
          currency: currencyCode as string,
          country: parsedAddress.country,
        }, 'Requesting shipping quote');

        const { costUsd } = await ShippingGateway.getShippingCost(items, parsedAddress);
        const cost = await CurrencyGateway.convert(costUsd!, currencyCode as string);

        const duration = Date.now() - startTime;
        metrics.shippingQuotes.add(1, {
          status: 'success',
          country: parsedAddress.country || 'unknown',
        });
        metrics.apiDuration.record(duration, {
          endpoint: '/api/shipping',
          method: 'GET',
          status: 'success',
        });

        logger.info({
          event: 'shipping_quote_calculated',
          itemCount: items.length,
          currency: currencyCode as string,
          country: parsedAddress.country,
          costAmount: cost?.units || 0,
          durationMs: duration,
        }, 'Shipping quote calculated successfully');

        return res.status(200).json(cost!);
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.shippingQuotes.add(1, {
          status: 'error',
          country: 'unknown',
        });
        metrics.apiDuration.record(duration, {
          endpoint: '/api/shipping',
          method: 'GET',
          status: 'error',
        });
        metrics.apiErrors.add(1, {
          endpoint: '/api/shipping',
          error_type: error instanceof Error ? error.name : 'unknown',
        });

        logger.error({
          event: 'shipping_quote_failed',
          currency: currencyCode as string,
          error: error instanceof Error ? error.message : String(error),
          durationMs: duration,
        }, 'Failed to calculate shipping quote');

        throw error;
      }
    }

    default: {
      return res.status(405);
    }
  }
};

export default InstrumentationMiddleware(handler);
