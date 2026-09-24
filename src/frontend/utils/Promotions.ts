// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

interface IPromotion {
  percentOff: number;
}

const promotions: Record<string, IPromotion> = {
  '66VCHSJNUP': { percentOff: 10 },
};

export const getPromotionLabel = (productId: string) => `${promotions[productId].percentOff}% off`;
