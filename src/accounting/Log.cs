// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging;
using Oteldemo;

namespace Accounting
{
    internal static partial class Log
    {
        [LoggerMessage(
            Level = LogLevel.Information,
            Message = "Order details: {@OrderResult}.")]
        public static partial void OrderReceivedMessage(ILogger logger, OrderResult orderResult);

        [LoggerMessage(EventId = 2, Level = LogLevel.Information,
            Message = "Kafka message timing: orderId={OrderId} publishedAt={PublishedAt:O} consumedAt={ConsumedAt:O} deltaSeconds={DeltaSeconds:F3}")]
        public static partial void KafkaMessageTiming(
            ILogger logger,
            string orderId,
            DateTime publishedAt,
            DateTime consumedAt,
            double deltaSeconds);
    }
}
