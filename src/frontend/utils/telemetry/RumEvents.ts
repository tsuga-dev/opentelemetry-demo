// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { faro } from '@grafana/faro-web-sdk';

export enum RumEvent {
  CartOpen = 'cart-open',
  CartEmpty = 'cart-empty',
  ProductView = 'product-view',
  AddToCart = 'add-to-cart',
  CurrencyChange = 'currency-change',
  CartQuantityChange = 'cart-quantity-change',
  CheckoutSubmit = 'checkout-submit',
  PurchaseCompleted = 'purchase-completed',
}

const labels: Record<RumEvent, string> = {
  [RumEvent.CartOpen]: 'cart-icon',
  [RumEvent.CartEmpty]: 'empty-cart',
  [RumEvent.ProductView]: 'product-card',
  [RumEvent.AddToCart]: 'add-to-cart',
  [RumEvent.CurrencyChange]: 'currency-selector',
  [RumEvent.CartQuantityChange]: 'quantity-selector',
  [RumEvent.CheckoutSubmit]: 'place-order',
  [RumEvent.PurchaseCompleted]: 'order-confirmed',
};

export const countBucket = (count: number) => {
  if (count <= 1) return '1';
  if (count <= 5) return '2-5';
  return '6+';
};

const pushAction = (name: string, attributes: Record<string, string>) => {
  // Faro drops an event identical to the previous one, so two clicks on one button would count once.
  faro.api?.pushEvent(name, attributes, undefined, { skipDedupe: true });
};

export const pushRumEvent = (name: RumEvent, attributes: Record<string, string> = {}) => {
  pushAction(name, { label: labels[name], ...attributes });
};

const INTERACTIVE_SELECTOR = 'button, a, summary, [role="button"], [role="menuitem"], [role="tab"], [role="option"]';

// Lowercases and collapses every run of non-alphanumeric characters into a single dash, e.g. "Place Order" -> "place-order".
const toKebabCase = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const clean = (value: string | null | undefined) => (value ? toKebabCase(value) : '') || undefined;

const getClickLabel = (element: HTMLElement) => {
  const label =
    clean(element.getAttribute('aria-label')) ??
    clean(element.getAttribute('data-rum-label')) ??
    clean(element.textContent) ??
    clean(element.getAttribute('title')) ??
    clean(element.getAttribute('data-testid'));
  return label?.slice(0, 100);
};

export const installClickTracking = () => {
  const handler = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement>(INTERACTIVE_SELECTOR);
    if (!element) return;
    const tag = element.tagName.toLowerCase();
    pushAction('click', { label: getClickLabel(element) ?? tag, tag });
  };

  // Capture phase, so a handler calling stopPropagation() does not hide the click.
  document.addEventListener('click', handler, { capture: true });
};
