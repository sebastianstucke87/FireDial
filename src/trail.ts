// Undo for the selection. It belongs to this tab and lasts until the next real change, so its
// steps are always newer than the store's: undo goes through them first.

export const sameItems = <Id>(a: readonly Id[], b: readonly Id[]): boolean => {
  const items = new Set(a)
  return a.length === b.length && b.every((item) => items.has(item))
}

export class SelectionTrail<Selection> {
  private past: Selection[] = []
  private future: Selection[] = []
  private readonly same: (a: Selection, b: Selection) => boolean

  constructor(same: (a: Selection, b: Selection) => boolean) {
    this.same = same
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  record(before: Selection, after: Selection): void {
    if (this.same(before, after)) return
    this.past.push(before)
    this.future = []
  }

  // Both return the selection to go to, null when there's no step left.
  undo(current: Selection): Selection | null {
    const step = this.past.pop()
    if (step === undefined) return null
    this.future.push(current)
    return step
  }

  redo(current: Selection): Selection | null {
    const step = this.future.pop()
    if (step === undefined) return null
    this.past.push(current)
    return step
  }

  clear(): void {
    this.past = []
    this.future = []
  }
}
