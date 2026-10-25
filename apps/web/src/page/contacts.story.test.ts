import { Array } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { AddContact, ContactsData, Message, Submission, init, update } from './contacts'
import { fixture } from './fixtures'

const loaded = modifyFields(init().model, { contacts: () => ContactsData.Success({ data: fixture.contacts }) })
const dave = 'GDAOGLNF2RL43GMCP5KRQPOOHGBVAOHOZSL6ANBCT6TVZGTCZMJDE7F6'

describe('Contacts', () => {
  test('a malformed address is never sent', () => {
    story(
      update,
      given(loaded),
      message(Message.UpdatedName({ value: 'Dave' })),
      message(Message.UpdatedAddress({ value: 'GDAO-not-an-address' })),
      message(Message.SubmittedContactForm()),
      Command.expectNone(),
      model(nextModel => {
        expect(nextModel.submission).toEqual(Submission.Idle())
      }),
    )
  })

  test('a valid contact is saved trimmed and upper-cased, then the form clears', () => {
    const saved = { ...Array.getUnsafe(fixture.contacts, 0), id: 'ctc_dave', display_name: 'Dave' }
    story(
      update,
      given(loaded),
      message(Message.UpdatedName({ value: '  Dave ' })),
      message(Message.UpdatedAddress({ value: ` ${dave.toLowerCase()} ` })),
      message(Message.SubmittedContactForm()),
      Command.expectExact(AddContact({ displayName: 'Dave', address: dave })),
      Command.resolve(AddContact, Message.SucceededAddContact({ contact: saved })),
      model(nextModel => {
        expect(nextModel.name).toBe('')
        expect(nextModel.address).toBe('')
        expect(nextModel.contacts).toEqual({ _tag: 'Success', data: [...fixture.contacts, saved] })
      }),
    )
  })
})
