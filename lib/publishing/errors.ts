export class PublishingDeferred extends Error {
  readonly code: string;
  constructor(message: string, code = "PUBLISHING_DEFERRED") {
    super(message); this.name = "PublishingDeferred"; this.code = code;
  }
}
