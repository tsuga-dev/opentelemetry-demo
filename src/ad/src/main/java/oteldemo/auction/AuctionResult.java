/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.auction;

public record AuctionResult(
    String winner, double winningBid, int biddersCalled, int bidsReceived) {}
