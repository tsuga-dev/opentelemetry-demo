// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../protos/demo';
import ProductCatalogService from '../../../services/ProductCatalog.service';

type TResponse = Product[] | Empty;

// --- Faulty-build degradation (Tsuga demo) -----------------------------------
// Gated on FAULTY_BUILD=1, which the Phase 3 fault overlay sets at deploy time.
// The env is read per-request so the same image behaves normally unless the
// overlay flips it on. Introduces a bounded regression (added latency + a
// fractional error rate) — a detectable degradation, never a hard crash.
async function maybeDegrade(): Promise<void> {
  if (process.env.FAULTY_BUILD !== '1') return;
  await new Promise(resolve => setTimeout(resolve, 400)); // added p50 latency
  if (Math.random() < 0.15) {
    // ~15% error rate
    throw new Error('faulty-build: simulated products gateway degradation');
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
