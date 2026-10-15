/** Stage 1 is an artifact check, never a runtime composition. */
export const preparationStatus = Object.freeze({
  state: "preparation-only",
  publishingEnabled: false,
  databaseConnected: false,
  runtimeImplemented: false,
});
