/**
 * Mirrors the Pipeline's tagged-path game-boundary rule (onUciNewGame +
 * maybeBindBlack + onGo binding state) so a log can be scanned for game starts
 * without driving a Pipeline. Tracks only WHEN collecting ends, not colours. A
 * parity test pins it to the Pipeline; update both together.
 */
export class GameSegmenter {
  private collecting = false;
  private participants = new Set<string>();
  private awaitingFirstGo = false;
  private whiteId?: string;
  private blackId?: string;

  /** Feed an `in` `ucinewgame`; returns true when this line opens a new game. */
  onUciNewGame(id?: string): boolean {
    let opened = false;
    if (!this.collecting) {
      this.collecting = true;
      this.participants.clear();
      this.whiteId = undefined;
      this.blackId = undefined;
      this.awaitingFirstGo = true;
      opened = true;
    }
    if (id) this.participants.add(id);
    this.maybeBind();
    return opened;
  }

  /** Feed an `in` `go` line. */
  onGo(id?: string): void {
    if (this.awaitingFirstGo && id) {
      this.whiteId = id;
      this.awaitingFirstGo = false;
      this.maybeBind();
    }
  }

  private maybeBind(): void {
    if (!this.whiteId || this.blackId) return;
    const others = [...this.participants].filter((p) => p !== this.whiteId);
    if (others.length !== 1) return;
    this.blackId = others[0];
    this.collecting = false;
    this.awaitingFirstGo = false;
  }
}
