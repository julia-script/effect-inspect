import { Effect } from 'effect'
import { Runtime } from 'foldkit'
import { Flags, Model, Message, init, subscriptions, update, view } from './main.ts'
import './styles.css'

Runtime.run(
  Runtime.makeApplication({
    Flags,
    Model,
    init,
    subscriptions,
    update,
    view,
    container: document.getElementById('root'),
    devTools: {
      mode: 'Inspect',
      Message,
      excludeFromHistory: [
        'SampledTrace',
        'SampledChart',
        'HoveredSpan',
        'ScrolledLog',
        'CompletedBrowserAction',
      ],
    },
  }),
  { flags: Effect.sync(() => ({ path: window.location.pathname })) },
)
