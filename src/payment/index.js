// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const health = require('grpc-js-health-check')
const opentelemetry = require('@opentelemetry/api')

const charge = require('./charge')
const logger = require('./logger')
const paymentMetrics = require('./metrics')

async function chargeServiceHandler(call, callback) {
  const span = opentelemetry.trace.getActiveSpan();
  
  // Track active connection
  paymentMetrics.activeConnections.add(1);

  try {
    const amount = call.request.amount
    const amountValue = parseFloat(`${amount.units}.${amount.nanos}`).toFixed(2);
    
    span?.setAttributes({
      'app.payment.amount': amountValue
    })
    
    logger.info({
      msg: 'Charge request received',
      amount: amountValue,
      currency: amount.currencyCode,
    });

    const response = await charge.charge(call.request)
    
    logger.info({
      msg: 'Charge request completed successfully',
      transaction_id: response.transactionId,
    });
    
    callback(null, response)

  } catch (err) {
    logger.error({
      msg: 'Charge request failed',
      error: err.message,
    });

    span?.recordException(err)
    span?.setStatus({ code: opentelemetry.SpanStatusCode.ERROR })
    callback(err)
  } finally {
    // Track connection closed
    paymentMetrics.activeConnections.add(-1);
  }
}

async function closeGracefully(signal) {
  server.forceShutdown()
  process.kill(process.pid, signal)
}

const otelDemoPackage = grpc.loadPackageDefinition(protoLoader.loadSync('demo.proto'))
const server = new grpc.Server()

server.addService(health.service, new health.Implementation({
  '': health.servingStatus.SERVING
}))

server.addService(otelDemoPackage.oteldemo.PaymentService.service, { charge: chargeServiceHandler })


let ip = "0.0.0.0";

const ipv6_enabled = process.env.IPV6_ENABLED;

if (ipv6_enabled == "true") {
  ip = "[::]";
  logger.info(`Overwriting Localhost IP: ${ip}`)
}

const address = ip + `:${process.env['PAYMENT_PORT']}`;

server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    return logger.error({ err })
  }

  logger.info(`payment gRPC server started on ${address}`)
})

process.once('SIGINT', closeGracefully)
process.once('SIGTERM', closeGracefully)
