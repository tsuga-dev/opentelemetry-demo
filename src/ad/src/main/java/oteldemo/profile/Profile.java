/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.profile;

public record Profile(long cpuNanos) {
  public double cpuSeconds() {
    return cpuNanos / 1e9;
  }
}
