import type { Html, HtmlBuilder } from 'foldkit/html'

import { Disclosure } from '@foldkit/ui'

/** Inline disclosure: ordinary document flow and no overlay or focus trap. */
export const disclosure = <Message>(
  id: string,
  label: string,
  isOpen: boolean,
  onToggle: (isOpen: boolean) => Message,
  content: () => Html,
  h: HtmlBuilder<Message>,
): Html =>
  Disclosure.view(
    {
      id,
      isOpen,
      onToggle,
      toView: attributes =>
        h.div(
          [h.Class('min-w-0')],
          [
            h.button(
              [
                ...attributes.button,
                h.Class(
                  'inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent',
                ),
              ],
              [
                label,
                h.svg(
                  [
                    h.ViewBox('0 0 16 16'),
                    h.AriaHidden(true),
                    h.Class(`size-4 shrink-0 ${isOpen ? 'rotate-180' : ''}`),
                  ],
                  [h.path([h.D('m4 6 4 4 4-4'), h.Fill('none'), h.Stroke('currentColor'), h.StrokeWidth('1.5')])],
                ),
              ],
            ),
            isOpen ? h.div([...attributes.panel, h.Class('pt-3')], [content()]) : h.empty,
          ],
        ),
    },
    h,
  )
