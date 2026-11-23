// @omazyai/sdk/ui/server: the server half of the ui kit. `uiRoutes` answers
// the screens' requests from the guard, the oauth server, the ai kit's memory
// and the copilot's grants. It is its own entry so the browser entry,
// `@omazyai/sdk/ui`, carries no server code.

export { type AppsSource, type UiRoutes, type UiRoutesOptions, uiRoutes } from './routes.js'
