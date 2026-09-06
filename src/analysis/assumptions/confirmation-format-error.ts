/** A confirmations file that does not match the documented `{ "confirmations": [...] }` shape. */
export class ConfirmationFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfirmationFormatError";
  }
}
