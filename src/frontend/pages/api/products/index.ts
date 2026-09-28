// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../protos/demo';
import ProductCatalogService from '../../../services/ProductCatalog.service';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

type TResponse = Product[] | Empty;

const logger = logs.getLogger('frontend');

async function maybeDegrade(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 400));
  if (Math.random() < 0.30) {
    const message = process.env.FAULT_ERROR_MESSAGE || 'failed to load products';
    logger.emit({ severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', body: message });
    throw new Error(message);
  }
}

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      await maybeDegrade();

      const { currencyCode = '' } = query;
      const productList = await ProductCatalogService.listProducts(currencyCode as string);

      return res.status(200).json(productList);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
