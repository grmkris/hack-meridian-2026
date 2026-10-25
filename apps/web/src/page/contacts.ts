import { Array, Effect, Option, Schema, String } from 'effect'
import { AsyncData, Command, Submodel, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { StellarAddress } from '@hm/protocol'

import { Backend, Contact, type Resources } from '../backend'
import { dateTime, explorerAccountUrl, shortAddress } from '../format'
import { Problem, recoverProblem } from '../problem'
import {
  BUTTON_PRIMARY,
  INPUT,
  LINK,
  emptyRow,
  errorRow,
  loadingRow,
  pageHeader,
  panel,
  readinessBadge,
  readinessHelp,
} from '../view/ui'

// MODEL

export const ContactsData = AsyncData.Schema(Schema.Array(Contact), Schema.String)

export const Submission = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Failed: { error: Schema.String },
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  contacts: ContactsData.schema,
  name: Schema.String,
  address: Schema.String,
  submission: Submission,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  EnteredPage: {},
  SucceededLoadContacts: { contacts: Schema.Array(Contact) },
  FailedLoadContacts: { problem: Problem },
  UpdatedName: { value: Schema.String },
  UpdatedAddress: { value: Schema.String },
  SubmittedContactForm: {},
  SucceededAddContact: { contact: Contact },
  FailedAddContact: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ EndedSession: {} })
export type OutMessage = typeof OutMessage.Type

// INIT

export const init = (): Update.Return<Model, Message, Resources> => ({
  model: { contacts: ContactsData.Idle(), name: '', address: '', submission: Submission.Idle() },
})

// COMMAND

export const LoadContacts = Command.define('LoadContacts', {
  messages: [Message.SucceededLoadContacts, Message.FailedLoadContacts],
  execute: Effect.gen(function* () {
    const backend = yield* Backend
    const contacts = yield* backend.contacts
    return Message.SucceededLoadContacts({ contacts })
  }).pipe(recoverProblem(problem => Message.FailedLoadContacts({ problem }))),
})

export const AddContact = Command.define('AddContact', {
  args: { displayName: Schema.String, address: Schema.String },
  messages: [Message.SucceededAddContact, Message.FailedAddContact],
  execute: ({ displayName, address }) =>
    Effect.gen(function* () {
      const backend = yield* Backend
      const contact = yield* backend.addContact({ display_name: displayName, address })
      return Message.SucceededAddContact({ contact })
    }).pipe(recoverProblem(problem => Message.FailedAddContact({ problem }))),
})

// UPDATE

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

const isStellarAddress = Schema.is(StellarAddress)

const formAddress = (model: Model): string => String.toUpperCase(String.trim(model.address))

export const isFormValid = (model: Model): boolean =>
  String.isNonEmpty(String.trim(model.name)) && isStellarAddress(formAddress(model))

const endSession = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { contacts: () => ContactsData.Idle(), submission: () => Submission.Idle() }),
  outMessage: OutMessage.EndedSession(),
})

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    EnteredPage: () =>
      Option.match(AsyncData.revalidateOrLoad(model.contacts), {
        onNone: () => ({ model }),
        onSome: nextContacts => ({
          model: modifyFields(model, { contacts: () => nextContacts }),
          commands: [LoadContacts()],
        }),
      }),
    SucceededLoadContacts: ({ contacts }) => ({
      model: modifyFields(model, { contacts: () => ContactsData.Success({ data: contacts }) }),
    }),
    FailedLoadContacts: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => ({ model: modifyFields(model, { contacts: () => ContactsData.Failure({ error }) }) }),
      }),
    UpdatedName: ({ value }) => ({ model: modifyFields(model, { name: () => value }) }),
    UpdatedAddress: ({ value }) => ({ model: modifyFields(model, { address: () => value }) }),
    SubmittedContactForm: () => {
      if (!isFormValid(model) || Submission.guards.Saving(model.submission)) {
        return { model }
      }
      return {
        model: modifyFields(model, { submission: () => Submission.Saving() }),
        commands: [AddContact({ displayName: String.trim(model.name), address: formAddress(model) })],
      }
    },
    SucceededAddContact: ({ contact }) => ({
      model: modifyFields(model, {
        contacts: AsyncData.map(contacts => [...contacts, contact]),
        name: () => '',
        address: () => '',
        submission: () => Submission.Idle(),
      }),
    }),
    FailedAddContact: ({ problem }) =>
      Problem.match<UpdateReturn>(problem, {
        SignedOut: () => endSession(model),
        Failed: ({ error }) => ({ model: modifyFields(model, { submission: () => Submission.Failed({ error }) }) }),
      }),
  })

export const informEntered = (model: Model) => update(model, Message.EnteredPage())

// VIEW

const destinationRow = (destination: Contact['destinations'][number], h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    destination.address,
    [h.Class('flex flex-col gap-1')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.a(
            [
              h.Href(explorerAccountUrl(destination.network, destination.address)),
              h.Target('_blank'),
              h.Rel('noreferrer'),
              h.Title(destination.address),
              h.Class(`${LINK} font-mono text-sm`),
            ],
            [shortAddress(destination.address)],
          ),
          readinessBadge(destination.readiness, h),
        ],
      ),
      h.p(
        [h.Class('text-sm text-muted')],
        [
          Option.match(Option.fromNullishOr(destination.last_paid_at), {
            onNone: () => readinessHelp(destination.readiness),
            onSome: paidAt => `${readinessHelp(destination.readiness)} Last paid ${dateTime(paidAt)}.`,
          }),
        ],
      ),
    ],
  )

const contactRow = (contact: Contact, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    contact.id,
    [h.Class('flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between')],
    [
      h.div(
        [h.Class('flex flex-col')],
        [
          h.span([h.Class('font-semibold text-ink')], [contact.display_name]),
          ...Array.match(contact.aliases, {
            onEmpty: () => [],
            onNonEmpty: aliases => [h.span([h.Class('text-sm text-muted')], [`Also “${aliases.join('”, “')}”`])],
          }),
        ],
      ),
      h.ul(
        [h.Class('flex flex-col gap-3 sm:items-end sm:text-right')],
        Array.map(contact.destinations, destination => destinationRow(destination, h)),
      ),
    ],
  )

const addressHint = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  String.isNonEmpty(String.trim(model.address)) && !isStellarAddress(formAddress(model))
    ? [
        h.p(
          [h.Id('contact-address-hint'), h.Class('text-sm text-danger')],
          ['A Stellar address starts with G, C or M and has 56 characters (69 for M).'],
        ),
      ]
    : []

const formView = (model: Model, h: HtmlBuilder<Message>): Html =>
  panel(
    'Add a contact',
    [
      h.form(
        [h.Class('grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end'), h.OnSubmit(Message.SubmittedContactForm())],
        [
          h.div(
            [h.Class('flex flex-col gap-1')],
            [
              h.label([h.For('contact-name'), h.Class('text-sm font-medium text-ink')], ['Name']),
              h.input([
                h.Id('contact-name'),
                h.Type('text'),
                h.Value(model.name),
                h.Autocomplete('off'),
                h.Class(INPUT),
                h.OnInput(value => Message.UpdatedName({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-1')],
            [
              h.label([h.For('contact-address'), h.Class('text-sm font-medium text-ink')], ['Stellar address']),
              h.input([
                h.Id('contact-address'),
                h.Type('text'),
                h.Value(model.address),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.AriaDescribedBy('contact-address-hint'),
                h.Class(`${INPUT} font-mono`),
                h.OnInput(value => Message.UpdatedAddress({ value })),
              ]),
            ],
          ),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(!isFormValid(model) || Submission.guards.Saving(model.submission)),
              h.Class(BUTTON_PRIMARY),
            ],
            [Submission.matchOrElse(model.submission, { Saving: () => 'Saving…' }, () => 'Add contact')],
          ),
        ],
      ),
      ...addressHint(model, h),
      ...Submission.matchOrElse(model.submission, { Failed: ({ error }) => [errorRow(error, h)] }, () => []),
    ],
    h,
  )

export const view = Submodel.defineView<Model, Message>((model, h): Html =>
  h.div(
    [h.Class('flex flex-col gap-5')],
    [
      pageHeader(
        'Contacts',
        'People your AI can pay by name. Each address shows whether it can receive USDC right now; a new address on an existing contact needs your confirmation.',
        h,
      ),
      formView(model, h),
      panel(
        'Saved contacts',
        [
          AsyncData.matchData(model.contacts, {
            onEmpty: () => loadingRow(h),
            onFailure: error => errorRow(error, h),
            onData: contacts =>
              Array.match(contacts, {
                onEmpty: () => emptyRow('No contacts yet.', h),
                onNonEmpty: list =>
                  h.ul(
                    [h.Class('divide-y divide-line')],
                    Array.map(list, contact => contactRow(contact, h)),
                  ),
              }),
          }),
        ],
        h,
      ),
    ],
  ),
)
