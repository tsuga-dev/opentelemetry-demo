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

      logger.info({
        event: 'shipping_quote_calculated',
        itemCount: items.length,
        currency: currencyCode as string,
        country: parsedAddress.country,
        costAmount: cost?.units || 0,
        durationMs: duration,
      }, 'Shipping quote calculated successfully');

      return res.status(200).json(cost!);
    }

    default: {
      return res.status(405);
    }
  }
};

export default InstrumentationMiddleware(handler);
