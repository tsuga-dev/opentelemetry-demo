/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.profile;

public enum ProfileLevel {
  LOW(1),
  MEDIUM(4),
  HIGH(10),
  EXTREME(25);

  public final int richness;

  ProfileLevel(int richness) {
    this.richness = richness;
  }

  public static ProfileLevel parse(String value) {
    if (value == null) {
      return LOW;
    }
    try {
      return valueOf(value.trim().toUpperCase(java.util.Locale.ROOT));
    } catch (IllegalArgumentException e) {
      return LOW;
    }
  }

  public String attributeValue() {
    return name().toLowerCase(java.util.Locale.ROOT);
  }
}
