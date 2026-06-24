/**
 * Thrown by the create caller when the POST fails, carrying the HTTP status so
 * the form can distinguish the equipment-not-found 404 (the only 404 the create
 * path raises) from a generic save failure.
 */
export class WorkOrderCreateError extends Error {
  constructor(readonly status: number) {
    super(`work-order create failed with status ${String(status)}`);
    this.name = "WorkOrderCreateError";
  }
}
