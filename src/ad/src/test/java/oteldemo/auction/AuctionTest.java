/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.auction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class AuctionTest {

  private final List<HttpServer> servers = new ArrayList<>();

  @AfterEach
  void stopServers() {
    servers.forEach(s -> s.stop(0));
  }

  private URI stub(int status, String body, long sleepMs) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
    server.createContext(
        "/bid",
        exchange -> {
          try {
            Thread.sleep(sleepMs);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
          } catch (Exception ignored) {
          } finally {
            exchange.close();
          }
        });
    server.start();
    servers.add(server);
    return URI.create("http://localhost:" + server.getAddress().getPort());
  }

  private static Auction auction(List<URI> bidders) {
    return new Auction(bidders, Duration.ofMillis(100), HttpClient.newHttpClient());
  }

  @Test
  void highestBidWins() throws Exception {
    Auction auction =
        auction(List.of(stub(200, "0.002", 0), stub(200, "0.005", 0), stub(200, "0.003", 0)));
    AuctionResult result = auction.run(4, List.of("a"), false);
    assertEquals(0.005, result.winningBid(), 1e-9);
    assertEquals(3, result.bidsReceived());
    assertEquals(3, result.biddersCalled());
    assertEquals("localhost", result.winner());
  }

  @Test
  void slowBidderIsDropped() throws Exception {
    Auction auction = auction(List.of(stub(200, "0.009", 300), stub(200, "0.002", 0)));
    long start = System.nanoTime();
    AuctionResult result = auction.run(4, List.of("a"), false);
    long elapsedMs = (System.nanoTime() - start) / 1_000_000;
    assertEquals(0.002, result.winningBid(), 1e-9);
    assertEquals(1, result.bidsReceived());
    assertTrue(elapsedMs < 200, "took " + elapsedMs + " ms");
  }

  @Test
  void badBiddersIgnored() throws Exception {
    Auction auction =
        auction(List.of(stub(500, "0.9", 0), stub(200, "abc", 0), stub(200, "0.001", 0)));
    AuctionResult result = auction.run(4, List.of("a"), false);
    assertEquals(0.001, result.winningBid(), 1e-9);
    assertEquals(1, result.bidsReceived());
  }

  @Test
  void allFailIsUnsold() {
    Auction auction =
        auction(List.of(URI.create("http://localhost:1"), URI.create("http://localhost:2")));
    AuctionResult result = auction.run(4, List.of("a"), false);
    assertEquals("", result.winner());
    assertEquals(0, result.winningBid(), 0);
    assertEquals(0, result.bidsReceived());
    assertEquals(2, result.biddersCalled());
  }

  @Test
  void sendsRichnessKeysAndSlowHeader() throws Exception {
    AtomicReference<String> query = new AtomicReference<>();
    AtomicReference<String> slow = new AtomicReference<>();
    HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
    server.createContext(
        "/bid",
        exchange -> {
          query.set(exchange.getRequestURI().getRawQuery());
          slow.set(exchange.getRequestHeaders().getFirst("X-Bidder-Slow"));
          byte[] bytes = "0.001".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    server.start();
    servers.add(server);
    Auction auction = auction(List.of(URI.create("http://localhost:" + server.getAddress().getPort())));
    auction.run(10, List.of("telescopes", "binoculars"), true);
    assertEquals("w=10&keys=telescopes%2Cbinoculars", query.get());
    assertEquals("true", slow.get());
  }

  @Test
  void fromEnvBlankIsNull() {
    assertNull(Auction.fromEnv("", null));
    assertNull(Auction.fromEnv(null, null));
  }

  @Test
  void fromEnvMalformedUrlIsNull() {
    assertNull(Auction.fromEnv("http://bad host:8080", null));
  }

  @Test
  void fromEnvBadDeadlineFallsBack() {
    Auction auction = Auction.fromEnv("http://localhost:8080", "abc");
    assertEquals(Duration.ofMillis(100), auction.deadline());
  }

  @Test
  void fromEnvOnlySeparatorsIsNull() {
    assertNull(Auction.fromEnv(",", null));
    assertNull(Auction.fromEnv(" , ", null));
  }
}
