import { Option } from 'effect'

import { fromStroops } from '@hm/protocol'

import { type Amount, toStroops } from '../format'

/** The wallet's full amount, grouped without rounding; the currency is a separate label. */
export const usdcNumber = (amount: Amount): string =>
  Option.match(toStroops(amount), {
    onNone: () => String(amount),
    onSome: value => {
      const [whole = '', fraction] = fromStroops(value).split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
      return fraction === undefined ? grouped : `${grouped}.${fraction}`
    },
  })
