// Incrementally turn a stream of assistant text deltas into complete,
// speakable sentences so read-aloud can start mid-generation instead of
// waiting for the whole reply. Buffers text, flushes on sentence boundaries,
// and never emits a partial fenced code block (we hold everything from an
// unclosed ``` onward until the fence closes, then it collapses via toSpeakable).

// End of a sentence: terminal punctuation (optionally followed by a closing
// quote/bracket) that is itself followed by whitespace or end-of-buffer, OR a
// blank line (paragraph break).
const SENTENCE_BOUNDARY = /[.!?…]+["')\]]?(?=\s|$)|\n\s*\n/g;
// Resume the boundary scan this far before the cursor, so a boundary whose
// look-ahead (`\s`, or the `\n\s*\n` paragraph break) only landed in the delta we
// just appended is still found. 64 chars is well past any realistic run of
// whitespace, and it bounds the re-scan to a constant.
const SCAN_OVERLAP = 64;

export class SentenceStreamer {
	private buffer = "";
	// Offsets below are all into `buffer`, and they let each push inspect only what it
	// just appended. The previous implementation re-ran a full fence scan (plus an
	// array of every fence position) and a second full boundary scan over the entire
	// remaining buffer on every delta, then re-sliced it: quadratic in stream length,
	// blocking the event loop in proportion to how much text is still pending (worst
	// case: a long fenced block, or one very long sentence, where the buffer keeps
	// growing and nothing is ever emitted).
	private scanned = 0;
	private fenceCursor = 0; // every fence starting before this offset is in fenceCount
	private fenceCount = 0; // ``` fences in the current buffer
	private lastFence = -1; // offset of the last fence in the current buffer, or -1
	private pendingFrom = -1; // start of a held-back (fenced) region not yet boundary-scanned, or -1
	private readonly boundaryRe = new RegExp(SENTENCE_BOUNDARY.source, "g"); // per-instance: shared /g state would be a footgun
	private boundary = 0; // offset just past the last *confirmed* sentence boundary

	// Feed a text delta; return any newly-complete chunks ready to speak.
	push(delta: string): string[] {
		this.buffer += delta;
		this.scan();
		return this.cut();
	}

	// End of stream: return whatever remains (including any dangling code block).
	flush(): string[] {
		const rest = this.buffer;
		this.reset();
		return rest.trim() ? [rest] : [];
	}

	reset(): void {
		this.buffer = "";
		this.scanned = 0;
		this.fenceCursor = 0;
		this.fenceCount = 0;
		this.lastFence = -1;
		this.pendingFrom = -1;
		this.boundary = 0;
	}

	private scan(): void {
		const s = this.buffer;

		// Fences: count the newly appended ones only. Start 2 chars early so a fence
		// split across two deltas (``` arrives as "``" + "`") is still seen whole.
		for (let i = s.indexOf("```", Math.max(0, this.fenceCursor - 2)); i !== -1; i = s.indexOf("```", i + 3)) {
			if (i < this.fenceCursor) continue; // already counted (the split-fence case)
			this.fenceCount++;
			this.lastFence = i;
		}
		this.fenceCursor = s.length;

		// Nothing inside an open fence is spoken until it closes, so its contents are
		// not boundary-scanned while it is open — that region can be arbitrarily large
		// (a long code block) and re-scanning it per delta is the quadratic case. The
		// cursor still moves past it and pendingFrom remembers where to come back to,
		// so the moment the fence closes we scan exactly the region we held back.
		const openFence = this.fenceCount % 2 === 1 ? this.lastFence : -1;
		if (openFence !== -1 && this.pendingFrom === -1) this.pendingFrom = openFence;
		if (openFence === -1) this.pendingFrom = -1;

		const from = this.pendingFrom !== -1 ? this.pendingFrom : Math.max(0, this.scanned - SCAN_OVERLAP);
		const to = openFence === -1 ? s.length : openFence;

		const re = this.boundaryRe;
		re.lastIndex = from;
		let m: RegExpExecArray | null;
		while ((m = re.exec(s)) !== null) {
			const end = m.index + m[0].length;
			if (end > to) break; // inside the open fence, or past the end of the buffer
			if (end > this.boundary) this.boundary = end;
			if (m.index === re.lastIndex) re.lastIndex++; // zero-length match guard
		}

		this.scanned = s.length;
	}

	// Hand back everything up to the next thing worth speaking: the first confirmed
	// sentence boundary, or the open fence if one exists (text ahead of an unclosed
	// fence is settled — nothing can be inserted before it).
	private cut(): string[] {
		const openFence = this.fenceCount % 2 === 1 ? this.lastFence : -1;
		const at = openFence !== -1 ? openFence : this.boundary;
		if (at <= 0) return [];
		const out = this.buffer.slice(0, at);
		// Fence accounting has to follow the buffer we actually keep: whatever fences
		// left in the emitted chunk are gone from the stream, so drop them from the
		// count (this is what keeps open/closed parity right across a cut).
		let dropped = 0;
		for (let i = out.indexOf("```"); i !== -1; i = out.indexOf("```", i + 3)) dropped++;
		this.fenceCount -= dropped;
		this.buffer = this.buffer.slice(at);
		// Offsets shift left by `at`.
		this.scanned = Math.max(0, this.scanned - at);
		this.fenceCursor = Math.max(0, this.fenceCursor - at);
		this.boundary = 0;
		this.lastFence = this.lastFence >= at ? this.lastFence - at : -1;
		this.pendingFrom = this.pendingFrom === -1 ? -1 : this.pendingFrom >= at ? this.pendingFrom - at : -1;
		return [out];
	}
}

