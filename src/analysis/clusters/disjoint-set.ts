export class DisjointSet {
  private readonly parents: number[];

  public constructor(size: number) {
    this.parents = Array.from({ length: size }, (_unused, index) => index);
  }

  public rootOf(index: number): number {
    const parent = this.parents[index];
    if (parent === undefined || parent === index) {
      return index;
    }
    const root = this.rootOf(parent);
    this.parents[index] = root;
    return root;
  }

  public join(left: number, right: number): void {
    const leftRoot = this.rootOf(left);
    const rightRoot = this.rootOf(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }

  public groups<Item>(items: readonly Item[]): readonly Item[][] {
    const byRoot = new Map<number, Item[]>();
    for (const [index, item] of items.entries()) {
      const root = this.rootOf(index);
      const members = byRoot.get(root) ?? [];
      members.push(item);
      byRoot.set(root, members);
    }
    return [...byRoot.values()];
  }
}
