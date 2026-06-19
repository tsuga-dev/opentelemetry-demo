<?php
// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0



use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\SpanKind;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Slim\App;

// --- Faulty-build degradation (Tsuga demo) -----------------------------------
// Gated on FAULTY_BUILD=1, which the Phase 3 fault overlay sets at deploy time.
// The env is read per-request so the same image behaves normally unless the
// overlay flips it on. Introduces a bounded regression (added latency + a
// fractional error rate) — a detectable degradation, never a hard crash.
function maybeDegrade(): void
{
    if (getenv('FAULTY_BUILD') !== '1') {
        return;
    }
    usleep(400000);                            // added p50 latency (~0.4s)
    if (mt_rand() / mt_getrandmax() < 0.15) {  // ~15% error rate
        throw new \RuntimeException('faulty-build: simulated quote degradation');
    }
}

function calculateQuote($jsonObject): float
{
    $quote = 0.0;
    $childSpan = Globals::tracerProvider()->getTracer('manual-instrumentation')
        ->spanBuilder('calculate-quote')
        ->setSpanKind(SpanKind::KIND_INTERNAL)
        ->startSpan();
    $childSpan->addEvent('Calculating quote');

    try {
        if (!array_key_exists('numberOfItems', $jsonObject)) {
            throw new \InvalidArgumentException('numberOfItems not provided');
        }
        $numberOfItems = intval($jsonObject['numberOfItems']);
        $costPerItem = 8.99;
        $quote = round($costPerItem * $numberOfItems, 2);

        $childSpan->setAttribute('demo.shipping.quote.items_count', $numberOfItems);
        $childSpan->setAttribute('demo.shipping.quote.cost.total', $quote);

        $childSpan->addEvent('Quote calculated, returning its value');

        //manual metrics
        static $counter;
        $counter ??= Globals::meterProvider()
            ->getMeter('quotes')
            ->createCounter('quotes', 'quotes', 'number of quotes calculated');
        $counter->add(1, ['number_of_items' => $numberOfItems]);
    } catch (\Exception $exception) {
        $childSpan->recordException($exception);
    } finally {
        $childSpan->end();
        return $quote;
    }
}

return function (App $app) {
    $app->post('/getquote', function (Request $request, Response $response, LoggerInterface $logger) {
        $span = Span::getCurrent();
        $span->addEvent('Received get quote request, processing it');

        maybeDegrade();

        $jsonObject = $request->getParsedBody();

        $data = calculateQuote($jsonObject);

        $payload = json_encode($data);
        $response->getBody()->write($payload);

        $span->addEvent('Quote processed, response sent back', [
            'demo.shipping.quote.cost.total' => $data
        ]);
        //exported as an opentelemetry log (see dependencies.php)
        $logger->info('Calculated quote', [
            'total' => $data,
        ]);

        return $response
            ->withHeader('Content-Type', 'application/json');
    });
};
