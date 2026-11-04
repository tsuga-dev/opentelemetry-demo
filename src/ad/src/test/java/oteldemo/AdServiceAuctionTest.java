/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import oteldemo.auction.Auction;
import org.junit.jupiter.api.Test;

class AdServiceAuctionTest {

  private static HttpServer stubBidder() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
    server.createContext(
        "/bid",
        exchange -> {
          byte[] bytes = "0.004".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    server.start();
    return server;
  }

  @Test
  void noSessionDefaultsToLowAndStillAuctions() throws Exception {
    HttpServer server = stubBidder();
    try {
      Auction auction =
          new Auction(
              List.of(URI.create("http://localhost:" + server.getAddress().getPort())),
              Duration.ofMillis(100),
              HttpClient.newHttpClient());
      Client client = OpenFeatureAPI.getInstance().getClient();

      Attributes attrs =
          AdService.auctionAdSpot(
              auction, client, 0.15, List.of("telescopes"), null, new MutableContext());

      assertEquals("low", attrs.get(AttributeKey.stringKey("demo.ad.profile.level")));
      assertEquals(0.004, attrs.get(AttributeKey.doubleKey("demo.ad.auction.winning_bid")));
      assertEquals(1L, attrs.get(AttributeKey.longKey("demo.ad.auction.bids.count")));
      assertTrue(attrs.get(AttributeKey.doubleKey("demo.ad.profile.cost")) > 0);
    } finally {
      server.stop(0);
    }
  }

  @Test
  void auctionFailureDoesNotThrow() {
    Client failing =
        (Client)
            Proxy.newProxyInstance(
                Client.class.getClassLoader(),
                new Class<?>[] {Client.class},
                (proxy, method, args) -> {
                  throw new RuntimeException("flag evaluation failed");
                });
    Auction auction =
        new Auction(
            List.of(URI.create("http://localhost:1")),
            Duration.ofMillis(100),
            HttpClient.newHttpClient());

    Attributes attrs =
        AdService.auctionAdSpot(
            auction, failing, 0.15, List.of("telescopes"), null, new MutableContext());

    assertEquals(Attributes.empty(), attrs);
  }
}
