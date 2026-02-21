// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import AdGateway from '../../gateways/rpc/Ad.gateway';
import { Ad, Empty } from '../../protos/demo';
import { metrics } from '../../utils/telemetry/metrics';
import logger from '../../utils/telemetry/logger';

type TResponse = Ad[] | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const startTime = Date.now();
      const { contextKeys = [] } = query;

      try {
        const contextArray = Array.isArray(contextKeys) ? contextKeys : contextKeys.split(',');

        logger.info({
          event: 'ads_requested',
          contextKeyCount: contextArray.length,
        }, 'Requesting contextual ads');

        const { ads: adList } = await AdGateway.listAds(contextArray);

        const duration = Date.now() - startTime;
        metrics.adsServed.add(adList.length);
        metrics.apiDuration.record(duration, {
          endpoint: '/api/data',
          method: 'GET',
          status: 'success',
        });

        logger.info({
          event: 'ads_served',
          adCount: adList.length,
          contextKeyCount: contextArray.length,
          durationMs: duration,
        }, 'Ads served successfully');

        return res.status(200).json(adList);
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.apiDuration.record(duration, {
          endpoint: '/api/data',
          method: 'GET',
          status: 'error',
        });
        metrics.apiErrors.add(1, {
          endpoint: '/api/data',
          error_type: error instanceof Error ? error.name : 'unknown',
        });

        logger.error({
          event: 'ads_fetch_failed',
          error: error instanceof Error ? error.message : String(error),
          durationMs: duration,
        }, 'Failed to fetch ads');

        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
