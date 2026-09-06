/** A scope flag could not be honoured: git is missing, the target is not a work tree, or a ref is unknown. */
export class GitScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitScopeError";
  }
}
