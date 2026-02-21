// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const paymentMetrics = require('./metrics');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('app.payment.transactions');

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

/** Return random element from given array */
function random(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const startTime = Date.now();
  const span = tracer.startSpan('charge');
  let paymentStatus = 'success';
  let errorType = null;
  let cardType = 'unknown';

  try {
    // Extract payment amount for logging and metrics
    const { units, nanos, currencyCode } = request.amount;
    const amountValue = parseFloat(`${units}.${String(nanos).padStart(9, '0').slice(0, 2)}`);
    
    logger.info({
      msg: 'Payment initiated',
      amount: amountValue,
      currency: currencyCode,
    });

    await OpenFeature.setProviderAndWait(flagProvider);

    const numberVariant = await OpenFeature.getClient().getNumberValue("paymentFailure", 0);
    
    // Track feature flag evaluation
    paymentMetrics.featureFlagEvaluations.add(1, {
      'flag_name': 'paymentFailure',
      'value': numberVariant.toString(),
    });

    if (numberVariant > 0) {
      // n% chance to fail with app.loyalty.level=gold
      if (Math.random() < numberVariant) {
        span.setAttributes({'app.loyalty.level': 'gold' });
        paymentStatus = 'failure';
        errorType = 'simulated_failure';
        
        logger.warn({
          msg: 'Payment failed due to feature flag simulation',
          flag_name: 'paymentFailure',
          flag_value: numberVariant,
          loyalty_level: 'gold',
        });
        
        paymentMetrics.paymentErrorsTotal.add(1, {
          'error_type': 'simulated_failure',
        });
        
        throw new Error('Payment request failed. Invalid token. app.loyalty.level=gold');
      }
    }

    const {
      creditCardNumber: number,
      creditCardExpirationYear: year,
      creditCardExpirationMonth: month
    } = request.creditCard;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const lastFourDigits = number.substr(-4);
    const transactionId = uuidv4();

    const card = cardValidator(number);
    const cardDetails = card.getCardDetails();
    cardType = cardDetails.card_type;
    const valid = cardDetails.valid;

    const loyalty_level = random(LOYALTY_LEVEL);

    span.setAttributes({
      'app.payment.card_type': cardType,
      'app.payment.card_valid': valid,
      'app.loyalty.level': loyalty_level
    });

    logger.info({
      msg: 'Card validation in progress',
      card_type: cardType,
      card_valid: valid,
      loyalty_level: loyalty_level,
    });

    // Perform fraud check
    paymentMetrics.fraudChecks.add(1, {
      'card_type': cardType,
      'loyalty_level': loyalty_level,
    });

    if (!valid) {
      paymentStatus = 'failure';
      errorType = 'invalid_card';
      
      logger.error({
        msg: 'Card validation failed',
        card_type: cardType,
        last_four: lastFourDigits,
      });
      
      paymentMetrics.paymentErrorsTotal.add(1, {
        'error_type': 'invalid_card',
      });
      
      throw new Error('Credit card info is invalid.');
    }

    if (!['visa', 'mastercard'].includes(cardType)) {
      paymentStatus = 'failure';
      errorType = 'unsupported_card_type';
      
      logger.warn({
        msg: 'Unsupported card type',
        card_type: cardType,
        last_four: lastFourDigits,
      });
      
      paymentMetrics.paymentErrorsTotal.add(1, {
        'error_type': 'unsupported_card_type',
      });
      
      throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
    }

    if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
      paymentStatus = 'failure';
      errorType = 'card_expired';
      
      logger.warn({
        msg: 'Card expired',
        card_type: cardType,
        last_four: lastFourDigits,
        expiry_month: month,
        expiry_year: year,
      });
      
      paymentMetrics.paymentErrorsTotal.add(1, {
        'error_type': 'card_expired',
      });
      
      throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
    }

    // Check baggage for synthetic_request=true, and add charged attribute accordingly
    const baggage = propagation.getBaggage(context.active());
    const isSynthetic = baggage && baggage.getEntry('synthetic_request') && baggage.getEntry('synthetic_request').value === 'true';
    
    if (isSynthetic) {
      span.setAttribute('app.payment.charged', false);
    } else {
      span.setAttribute('app.payment.charged', true);
    }
    
    // Record successful payment metrics
    paymentMetrics.paymentAttemptsTotal.add(1, {
      'status': 'success',
      'card_type': cardType,
    });
    
    paymentMetrics.paymentAmountTotal.add(amountValue, {
      'currency': currencyCode,
      'card_type': cardType,
    });
    
    const duration = (Date.now() - startTime) / 1000;
    paymentMetrics.paymentDuration.record(duration, {
      'card_type': cardType,
      'status': 'success',
    });
    
    logger.info({
      msg: 'Payment processed successfully',
      transaction_id: transactionId,
      card_type: cardType,
      last_four: lastFourDigits,
      amount: amountValue,
      currency: currencyCode,
      loyalty_level: loyalty_level,
      processing_duration_seconds: duration,
      is_synthetic: isSynthetic,
    });
    
    transactionsCounter.add(1, { 'app.payment.currency': currencyCode });

    return { transactionId };
    
  } catch (error) {
    // Record failed payment metrics
    if (paymentStatus === 'failure') {
      paymentMetrics.paymentAttemptsTotal.add(1, {
        'status': 'failure',
        'card_type': cardType || 'unknown',
      });
      
      const duration = (Date.now() - startTime) / 1000;
      paymentMetrics.paymentDuration.record(duration, {
        'card_type': cardType || 'unknown',
        'status': 'failure',
      });
    }
    
    logger.error({
      msg: 'Payment processing failed',
      error: error.message,
      error_type: errorType,
    });

    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

    throw error;
  } finally {
    span.end();
  }
};
