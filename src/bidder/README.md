# Bidder

Simulated third-party ad bidder, called by the `ad` service under the hostnames `bidder-astro`, `bidder-optics` and `bidder-generic`.
It is deliberately uninstrumented: no OpenTelemetry SDK, no agent, and it ignores trace context, like a real external party.
