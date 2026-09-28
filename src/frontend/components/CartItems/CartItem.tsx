// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Product } from '../../protos/demo';
import ProductPrice from '../ProductPrice';
import Select from '../Select';
import { countBucket, pushRumEvent, RumEvent } from '../../utils/telemetry/RumEvents';
import * as S from './CartItems.styled';

const quantityOptions = new Array(10).fill(0).map((_, i) => i + 1);

interface IProps {
  product: Product;
  quantity: number;
  onQuantityChange(productId: string, newQuantity: number): void;
}

const CartItem = ({
  product: { id, name, picture, priceUsd = { units: 0, nanos: 0, currencyCode: 'USD' } },
  quantity,
  onQuantityChange,
}: IProps) => {
  const totalNanos = Number(priceUsd.nanos) * quantity;
  const linePrice = {
    units: Number(priceUsd.units) * quantity + Math.floor(totalNanos / 1_000_000_000),
    nanos: totalNanos % 1_000_000_000,
    currencyCode: priceUsd.currencyCode,
  };

  return (
    <S.CartItem>
      <Link href={`/product/${id}`} data-rum-label="cart-item">
        <S.NameContainer>
          <S.CartItemImage alt={name} src={picture ? "/images/products/" + picture : undefined} />
          <p>{name}</p>
        </S.NameContainer>
      </Link>
      <S.CartItemDetails>
        <Select
          value={quantity}
          onChange={e => {
            pushRumEvent(RumEvent.CartQuantityChange, { surface: 'cart', quantity_bucket: countBucket(+e.target.value) });
            onQuantityChange(id, +e.target.value);
          }}
        >
          {quantityOptions.map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </Select>
      </S.CartItemDetails>
      <S.CartItemDetails>
        <S.PriceContainer>
          <p>
            <ProductPrice price={priceUsd} />
          </p>
        </S.PriceContainer>
      </S.CartItemDetails>
      <S.CartItemDetails>
        <S.PriceContainer>
          <p>
            <ProductPrice price={linePrice} />
          </p>
        </S.PriceContainer>
      </S.CartItemDetails>
    </S.CartItem>
  );
};

export default CartItem;
