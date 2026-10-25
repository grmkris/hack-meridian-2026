import { Array, Schema, String, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, literal } from 'foldkit/route'

export const AppRoute = defineRouteUnion({
  Home: {},
  Connections: {},
  Contacts: {},
  Receipts: {},
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))
export const connectionsRouter = pipe(literal('connections'), Route.mapTo(AppRoute.Connections))
export const contactsRouter = pipe(literal('contacts'), Route.mapTo(AppRoute.Contacts))
export const receiptsRouter = pipe(literal('receipts'), Route.mapTo(AppRoute.Receipts))

const routeParser = Route.oneOf(connectionsRouter, contactsRouter, receiptsRouter, homeRouter)

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)

const WORKER_PAGES = ['/approve/', '/authorize', '/claim/', '/oauth/', '/api/', '/mcp', '/.well-known/', '/sample']

export const isWorkerPage = (pathname: string): boolean =>
  Array.some(WORKER_PAGES, prefix => String.startsWith(prefix)(pathname))
