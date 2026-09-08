/** Source evidence for a state group, not a complete migration or an approval. */
export interface StateTransitionEvidence {
  /** Direct setter calls only. Transported setters require the existing child contract proofs. */
  writes: {
    state: string;
    line: number;
    column: number;
    handler: { name: string | null; line: number };
    /** Enclosing control constructs, from outermost to innermost. */
    controls: { kind: string; line: number }[];
  }[];
  /** Same-handler pairs only; indices refer to writes. Different handlers stay independent. */
  relations: {
    from: number;
    to: number;
    /** Proven means a shared synchronous path exists, not that all paths are atomic. */
    coexecution: "proven" | "disproven" | "unknown";
    /** Only adjacent, distinct-field literal writes support mechanical assign fusion. */
    fusion: "adjacent-literals" | "preserve-source";
  }[];
}
