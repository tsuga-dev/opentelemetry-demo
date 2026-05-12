<?php
// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

class RateLimiter
{
    private int $limit;
    private int $windowSeconds;

    public function __construct(int $limit = 100, int $windowSeconds = 60)
    {
        $this->limit = $limit;
        $this->windowSeconds = $windowSeconds;
    }

    public function __invoke(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if ($this->isRateLimited($request)) {
            throw new \RuntimeException('rate limit exceeded');
        }

        return $handler->handle($request);
    }

    private function isRateLimited(ServerRequestInterface $request): bool
    {
        static $counts = [];

        $client = $request->getServerParams()['REMOTE_ADDR'] ?? 'unknown';
        $window = (int) floor(time() / $this->windowSeconds);
        $key = "{$client}:{$window}";

        $counts[$key] = ($counts[$key] ?? 0) + 1;

        return $counts[$key] > $this->limit;
    }
}
