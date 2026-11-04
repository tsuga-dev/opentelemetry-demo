/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package oteldemo.profile;

import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.security.DigestException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class ProfileBuilder {

  static final int ROUNDS_PER_UNIT = 54000;

  private static volatile byte[] sink;

  private ProfileBuilder() {}

  public static Profile build(ProfileLevel level, String seed) {
    var threads = ManagementFactory.getThreadMXBean();
    long start = threads.getCurrentThreadCpuTime();
    byte[] state = initialState(seed);
    switch (level) {
      case LOW -> profileLevelLow(state);
      case MEDIUM -> profileLevelMedium(state);
      case HIGH -> profileLevelHigh(state);
      case EXTREME -> profileLevelExtreme(state);
    }
    return new Profile(level, threads.getCurrentThreadCpuTime() - start);
  }

  static void profileLevelLow(byte[] state) {
    matchSessionHistory(state);
  }

  static void profileLevelMedium(byte[] state) {
    matchSessionHistory(state);
    scoreCategoryAffinity(state);
  }

  static void profileLevelHigh(byte[] state) {
    matchSessionHistory(state);
    scoreCategoryAffinity(state);
    computeLookalikeAudience(state);
  }

  static void profileLevelExtreme(byte[] state) {
    matchSessionHistory(state);
    scoreCategoryAffinity(state);
    computeLookalikeAudience(state);
    runPurchaseIntentModel(state);
  }

  static void matchSessionHistory(byte[] state) {
    burn(state, 1);
  }

  static void scoreCategoryAffinity(byte[] state) {
    burn(state, 3);
  }

  static void computeLookalikeAudience(byte[] state) {
    burn(state, 6);
  }

  static void runPurchaseIntentModel(byte[] state) {
    burn(state, 15);
  }

  private static void burn(byte[] state, int units) {
    MessageDigest digest = newDigest();
    byte[] current = state.clone();
    try {
      for (int i = 0; i < units * ROUNDS_PER_UNIT; i++) {
        digest.update(current);
        digest.digest(current, 0, current.length);
      }
    } catch (DigestException e) {
      throw new IllegalStateException(e);
    }
    System.arraycopy(current, 0, state, 0, state.length);
    sink = current;
  }

  private static byte[] initialState(String seed) {
    return newDigest().digest(seed.getBytes(StandardCharsets.UTF_8));
  }

  private static MessageDigest newDigest() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
