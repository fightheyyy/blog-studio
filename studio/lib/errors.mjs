export class StudioError extends Error {
  constructor(message, { code = "STUDIO_ERROR", details = "", status = 400, context = {} } = {}) {
    super(message);
    this.name = "StudioError";
    Object.assign(this, { code, details, status, context });
  }
}
