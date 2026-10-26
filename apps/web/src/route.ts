import { Array, Option, Schema, String, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, literal } from 'foldkit/route'
import type { Url } from 'foldkit/url'

export const AppRoute = defineRouteUnion({
  Home: {},
  Connections: {},
  Contacts: {},
  Receipts: {},
  Receive: {},
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))
export const connectionsRouter = pipe(literal('connections'), Route.mapTo(AppRoute.Connections))
export const contactsRouter = pipe(literal('contacts'), Route.mapTo(AppRoute.Contacts))
export const receiptsRouter = pipe(literal('transactions'), Route.mapTo(AppRoute.Receipts))
export const receiveRouter = pipe(literal('receive'), Route.mapTo(AppRoute.Receive))
const legacyReceiptsRouter = pipe(literal('receipts'), Route.mapTo(AppRoute.Receipts))

const routeParser = Route.oneOf(
  connectionsRouter,
  contactsRouter,
  receiptsRouter,
  legacyReceiptsRouter,
  receiveRouter,
  homeRouter,
)

const parseRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)
export const urlToAppRoute = (url: Url): AppRoute =>
  url.pathname === '/' && Option.contains('add-money')(url.hash) ? AppRoute.Receive() : parseRoute(url)

const WORKER_PAGES = [
  '/approve/',
  '/authorize',
  '/claim/',
  '/oauth/',
  '/api/',
  '/mcp',
  '/.well-known/',
  '/sample',
  '/skill',
  '/SKILL.md',
]

export const isWorkerPage = (pathname: string): boolean =>
  Array.some(WORKER_PAGES, prefix => String.startsWith(prefix)(pathname))
