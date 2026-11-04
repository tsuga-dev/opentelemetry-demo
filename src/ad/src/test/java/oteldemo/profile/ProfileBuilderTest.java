/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.profile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

class ProfileBuilderTest {

  @Test
  void parseIsLenient() {
    assertEquals(ProfileLevel.HIGH, ProfileLevel.parse("HIGH"));
    assertEquals(ProfileLevel.EXTREME, ProfileLevel.parse("extreme"));
    assertEquals(ProfileLevel.LOW, ProfileLevel.parse(null));
    assertEquals(ProfileLevel.LOW, ProfileLevel.parse("bogus"));
  }

  @Test
  void richnessMatchesSpec() {
    assertEquals(1, ProfileLevel.LOW.richness);
    assertEquals(4, ProfileLevel.MEDIUM.richness);
    assertEquals(10, ProfileLevel.HIGH.richness);
    assertEquals(25, ProfileLevel.EXTREME.richness);
    assertEquals("extreme", ProfileLevel.EXTREME.attributeValue());
  }

  @Test
  void extremeCostsMoreThanLow() {
    for (ProfileLevel level : ProfileLevel.values()) {
      for (int i = 0; i < 50; i++) {
        ProfileBuilder.build(level, "warmup");
      }
    }
    long low = median(ProfileLevel.LOW);
    long extreme = median(ProfileLevel.EXTREME);
    for (ProfileLevel level : ProfileLevel.values()) {
      System.out.printf(
          "%s median cpu: %.3f ms%n", level, median(level) / 1e6);
    }
    assertTrue(extreme > 10 * low, "extreme=" + extreme + " low=" + low);
  }

  private static long median(ProfileLevel level) {
    long[] samples = new long[20];
    for (int i = 0; i < samples.length; i++) {
      samples[i] = ProfileBuilder.build(level, "visitor-" + i).cpuNanos();
    }
    Arrays.sort(samples);
    return samples[samples.length / 2];
  }
}
