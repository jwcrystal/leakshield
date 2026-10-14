/** Transactional ingress recovery shared by the three SSE protocol adapters.
 * Keep original frames until a token tail is resolved; on an adapter failure
 * release only the not-yet-delivered originals and bypass further rewriting.
 * No tee, rewind, synthetic completion or unbounded shadow stream is needed. */
const MAX_RETAINED_BYTES = 1_048_576;
const MAX_RETAINED_PARTS = 4096;

interface RewrittenEvent {
  output: string;
  holding: boolean;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}

export function createRecoveringSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  rewrite: (lines: string[], terminated: boolean) => RewrittenEvent,
  abandon: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let input: Uint8Array | undefined;
  let at = 0;
  let lineParts: Uint8Array[] = [], frameParts: Uint8Array[] = [], originals: Uint8Array[] = [];
  let lines: string[] = [], outputs: string[] = [];
  let lineBytes = 0, frameBytes = 0, originalBytes = 0, outputBytes = 0, retainedParts = 0;
  let bypass = false, finished = false, holding = false;

  const clear = (): void => {
    lineParts = []; frameParts = []; originals = []; lines = []; outputs = [];
    lineBytes = 0; frameBytes = 0; originalBytes = 0; outputBytes = 0; retainedParts = 0;
  };
  const recover = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    bypass = true;
    // Static, once per stream. Never include an exception or frame contents.
    console.warn("[sensitive-guard] degraded: SSE restoration stopped; undelivered original frames kept literal");
    abandon();
    for (const part of [...originals, ...frameParts, ...lineParts]) controller.enqueue(part);
    clear();
    if (input !== undefined && at < input.length) controller.enqueue(input.subarray(at));
    input = undefined;
    at = 0;
  };
  const commit = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const text = outputs.join("");
    originals = []; outputs = [];
    originalBytes = 0; outputBytes = 0; retainedParts = frameParts.length + lineParts.length;
    if (text) controller.enqueue(encoder.encode(text));
  };
  const event = (controller: ReadableStreamDefaultController<Uint8Array>, terminated: boolean): boolean => {
    const raw = concatenate(frameParts);
    originals.push(raw);
    originalBytes += raw.length;
    retainedParts += 1 - frameParts.length;
    const eventLines = lines;
    frameParts = []; lines = []; frameBytes = 0;
    try {
      const rewritten = rewrite(eventLines, terminated);
      outputBytes += encoder.encode(rewritten.output).length;
      if (outputBytes > MAX_RETAINED_BYTES) throw new Error("SSE rewrite budget");
      outputs.push(rewritten.output);
      holding = rewritten.holding;
      if (!holding) { commit(controller); return true; }
      return false;
    } catch {
      recover(controller);
      return true;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        for (;;) {
          if (input === undefined || at === input.length) {
            input = undefined;
            at = 0;
            // Source errors deliberately remain errors, not a recoverable
            // parser verdict. This read is outside the rewrite catch above.
            const next = await reader.read();
            if (finished) return;
            if (next.done) {
              if (!bypass) {
                if (holding) recover(controller);
                else if (lineParts.length || frameParts.length) {
                  try {
                    if (lineParts.length) {
                      lines.push(decoder.decode(concatenate(lineParts)));
                      frameParts.push(...lineParts);
                      frameBytes += lineBytes;
                      lineParts = []; lineBytes = 0;
                    }
                    event(controller, false);
                    if (holding && !bypass) recover(controller);
                  } catch { recover(controller); }
                }
              }
              finished = true;
              abandon();
              controller.close();
              return;
            }
            input = next.value;
          }
          if (bypass) {
            if (input.length) controller.enqueue(input.subarray(at));
            input = undefined;
            at = 0;
            return;
          }
          const newline = input.indexOf(10, at);
          const end = newline === -1 ? input.length : newline + 1;
          const fragment = input.subarray(at, end);
          if (originalBytes + frameBytes + lineBytes + fragment.length > MAX_RETAINED_BYTES || retainedParts >= MAX_RETAINED_PARTS) {
            recover(controller);
            return;
          }
          // Copy bounded slices so a tiny retained tail cannot pin a huge
          // backing ArrayBuffer supplied in a single upstream chunk.
          lineParts.push(fragment.slice());
          lineBytes += fragment.length;
          retainedParts += 1;
          at = end;
          if (newline === -1) continue;
          const rawLine = concatenate(lineParts);
          frameParts.push(...lineParts);
          frameBytes += lineBytes;
          lineParts = []; lineBytes = 0;
          let line: string;
          try { line = decoder.decode(rawLine.subarray(0, rawLine.length - 1)); }
          catch { recover(controller); return; }
          if (line === "" || line === "\r") {
            if (event(controller, true)) return;
          } else lines.push(line);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        clear();
        abandon();
        controller.error(error);
        void reader.cancel(error).catch(() => {});
      }
    },
    cancel(reason) {
      finished = true;
      input = undefined;
      clear();
      abandon();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
