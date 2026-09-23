// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { CypressFields } from '../../utils/enums/CypressFields';
import { useCart } from '../../providers/Cart.provider';
import CartDropdown from '../CartDropdown';
import { pushRumEvent, RumEvent } from '../../utils/telemetry/RumEvents';
import * as S from './CartIcon.styled';

const CartIcon = () => {
  const [isOpen, setIsOpen] = useState(false);
  const {
    cart: { items },
  } = useCart();

  return (
    <>
      <S.CartIcon
        data-cy={CypressFields.CartIcon}
        data-rum-label="cart-icon"
        onClick={() => {
          pushRumEvent(RumEvent.CartOpen, { surface: 'header' });
          setIsOpen(true);
        }}
      >
        <S.Icon src="/icons/CartIcon.svg" alt="Cart icon" title="Cart" />
        {!!items.length && <S.ItemsCount data-cy={CypressFields.CartItemCount}>{items.length}</S.ItemsCount>}
      </S.CartIcon>
      <CartDropdown productList={items} isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};

export default CartIcon;
