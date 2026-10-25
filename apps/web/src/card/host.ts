import { Context, Effect, Layer, Predicate, Schema } from 'effect'

import type { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

/**
 * What the card asks of the chat it is rendered in (the MCP Apps host): call one of Nod's own tools through the host,
 * open a link in the host's browser, and leave the AI one sentence of context. Commands reach the host only through
 * this service; `entry.ts` provides it over the ext-apps `App`, the bridge tests over a real `AppBridge`.
 */

/** The host refused, does not offer the capability, or the call failed on the way. */
export class HostFailed extends Schema.TaggedError<HostFailed>()('HostFailed', { reason: Schema.String }) {}

/** A tool result as the card reads it: the error flag, the structured value and the first text block. */
export const ToolReply = Schema.Struct({ isError: Schema.Boolean, structured: Schema.Unknown, text: Schema.String })
export type ToolReply = typeof ToolReply.Type

export class Host extends Context.Service<
  Host,
  {
    readonly callTool: (name: string, args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolReply, HostFailed>
    readonly openLink: (url: string) => Effect.Effect<void, HostFailed>
    readonly updateModelContext: (text: string) => Effect.Effect<void, HostFailed>
  }
>()('nod/card/Host') {}

const failed = (cause: unknown) =>
  new HostFailed({ reason: cause instanceof Error ? cause.message : 'The chat did not answer.' })

const firstText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ''
  }
  const block: unknown = content.find(item => Predicate.isObject(item) && item['type'] === 'text')
  return Predicate.isObject(block) && Predicate.isString(block['text']) ? block['text'] : ''
}

/** A `tools/call` result (or a `ui/notifications/tool-result` params object) as a `ToolReply`. */
export const toToolReply = (result: unknown): ToolReply =>
  Predicate.isObject(result)
    ? {
        isError: result['isError'] === true,
        structured: result['structuredContent'],
        text: firstText(result['content']),
      }
    : { isError: true, structured: undefined, text: '' }

/** The live host: the ext-apps `App` connected to the chat over postMessage. */
export const liveHost = (app: App): Layer.Layer<Host> =>
  Layer.succeed(
    Host,
    Host.of({
      callTool: (name, args) =>
        app.getHostCapabilities()?.serverTools === undefined
          ? Effect.fail(new HostFailed({ reason: 'This chat does not let cards call tools.' }))
          : Effect.tryPromise({
              try: () => app.callServerTool({ name, arguments: { ...args } }),
              catch: failed,
            }).pipe(Effect.map(toToolReply)),
      openLink: url =>
        app.getHostCapabilities()?.openLinks === undefined
          ? Effect.fail(new HostFailed({ reason: 'This chat does not open links from cards.' }))
          : Effect.tryPromise({ try: () => app.openLink({ url }), catch: failed }).pipe(
              Effect.flatMap(result =>
                result.isError === true
                  ? Effect.fail(new HostFailed({ reason: 'The chat did not open the link.' }))
                  : Effect.void,
              ),
            ),
      updateModelContext: text =>
        app.getHostCapabilities()?.updateModelContext === undefined
          ? Effect.void
          : Effect.tryPromise({
              try: () => app.updateModelContext({ content: [{ type: 'text', text }] }),
              catch: failed,
            }).pipe(Effect.asVoid),
    }),
  )
