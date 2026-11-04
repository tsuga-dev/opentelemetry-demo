/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.auction;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.OptionalDouble;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public final class Auction {

  private static final long DEFAULT_DEADLINE_MS = 100;

  private final List<URI> bidders;
  private final Duration deadline;
  private final HttpClient client;

  public Auction(List<URI> bidders, Duration deadline, HttpClient client) {
    this.bidders = bidders;
    this.deadline = deadline;
    this.client = client;
  }

  public static Auction fromEnv(String bidderUrls, String deadlineMs) {
    if (bidderUrls == null || bidderUrls.isBlank()) {
      return null;
    }
    List<URI> bidders;
    try {
      bidders =
          Arrays.stream(bidderUrls.split(","))
              .map(String::trim)
              .filter(s -> !s.isEmpty())
              .map(URI::create)
              .toList();
    } catch (IllegalArgumentException e) {
      return null;
    }
    if (bidders.isEmpty()) {
      return null;
    }
    return new Auction(bidders, Duration.ofMillis(parseDeadlineMs(deadlineMs)), HttpClient.newHttpClient());
  }

  private static long parseDeadlineMs(String deadlineMs) {
    try {
      return Long.parseLong(deadlineMs.trim());
    } catch (RuntimeException e) {
      return DEFAULT_DEADLINE_MS;
    }
  }

  Duration deadline() {
    return deadline;
  }

  public AuctionResult run(int richness, List<String> contextKeys, boolean bidderSlow) {
    String query =
        "w="
            + richness
            + "&keys="
            + URLEncoder.encode(String.join(",", contextKeys), StandardCharsets.UTF_8);

    List<CompletableFuture<OptionalDouble>> bids =
        bidders.stream().map(bidder -> bid(bidder, query, bidderSlow)).toList();

    try {
      CompletableFuture.allOf(bids.toArray(new CompletableFuture[0]))
          .get(deadline.toMillis() + 20, TimeUnit.MILLISECONDS);
    } catch (Exception ignored) {
    }
    bids.forEach(f -> f.cancel(true));

    String winner = "";
    double winningBid = 0;
    int received = 0;
    for (int i = 0; i < bidders.size(); i++) {
      OptionalDouble value = settledBid(bids.get(i));
      if (value.isEmpty()) {
        continue;
      }
      received++;
      if (value.getAsDouble() > winningBid || winner.isEmpty()) {
        winningBid = value.getAsDouble();
        winner = String.valueOf(bidders.get(i).getHost());
      }
    }
    return new AuctionResult(winner, winningBid, bidders.size(), received);
  }

  private CompletableFuture<OptionalDouble> bid(URI bidder, String query, boolean bidderSlow) {
    try {
      HttpRequest request =
          HttpRequest.newBuilder(URI.create(bidder + "/bid?" + query))
              .header("X-Bidder-Slow", String.valueOf(bidderSlow))
              .timeout(deadline)
              .GET()
              .build();
      return client
          .sendAsync(request, HttpResponse.BodyHandlers.ofString())
          .orTimeout(deadline.toMillis(), TimeUnit.MILLISECONDS)
          .thenApply(Auction::parseBid)
          .exceptionally(e -> OptionalDouble.empty());
    } catch (RuntimeException e) {
      return CompletableFuture.completedFuture(OptionalDouble.empty());
    }
  }

  private static OptionalDouble parseBid(HttpResponse<String> response) {
    if (response.statusCode() != 200) {
      return OptionalDouble.empty();
    }
    try {
      double value = Double.parseDouble(response.body().trim());
      return Double.isFinite(value) && value >= 0
          ? OptionalDouble.of(value)
          : OptionalDouble.empty();
    } catch (NumberFormatException e) {
      return OptionalDouble.empty();
    }
  }

  private static OptionalDouble settledBid(CompletableFuture<OptionalDouble> future) {
    if (future.isDone() && !future.isCancelled() && !future.isCompletedExceptionally()) {
      return future.getNow(OptionalDouble.empty());
    }
    return OptionalDouble.empty();
  }
}
