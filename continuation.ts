// tiny-continuation-loop: finish a long decode without lying about tokens.
// Fake model, fake tokens (1 word = 1 token). No API key. No network.
import { createHash } from "node:crypto";

type Request = { contents: string; systemInstruction: string; tools: string[] };
type Finish = "CONTINUATION" | "STOP" | "MAX_TOKENS";
type Usage = { prompt: number; text: number; thoughts: number };
type Checkpoint = { text: string; finish: Finish; token?: string; usage: Usage };

const count = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const hash = (r: Request) => createHash("sha256").update(JSON.stringify(r)).digest("hex");
const pack = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unpack = (t: string) => JSON.parse(Buffer.from(t, "base64url").toString());
const log = (s: string) => console.log(s);

// Each request decodes at most `perRequest` tokens, thinking first, then text.
// Text streams in chunks. The checkpoint (token + usage) arrives at the end.
class FakeModel {
  requests = 0;
  private dropAt = -1;
  constructor(
    private perRequest: number,
    private thoughts: number,
    private answer: string[],
  ) {}

  dropNextStreamAfter(chunks: number): void {
    this.dropAt = chunks;
  }

  async *stream(req: Request, maxOutput: number, token?: string): AsyncGenerator<string, Checkpoint> {
    this.requests += 1;
    let pos = 0;
    if (token) {
      const t = unpack(token);
      if (t.h !== hash(req)) throw new Error("400: continuation token does not match this request");
      pos = t.pos;
    }
    const total = this.thoughts + this.answer.length;
    const end = Math.min(pos + this.perRequest, total, maxOutput);
    const thoughts = Math.max(0, Math.min(end, this.thoughts) - pos);
    const words = this.answer.slice(Math.max(0, pos - this.thoughts), Math.max(0, end - this.thoughts));
    for (let i = 0, n = 0; i < words.length; i += 10, n += 1) {
      if (n === this.dropAt) {
        this.dropAt = -1;
        throw new Error("stream dropped");
      }
      yield words.slice(i, i + 10).join(" ");
    }
    const prompt = count(req.contents) + count(req.systemInstruction) + pos; // re-prefill
    const finish: Finish = end >= total ? "STOP" : end >= maxOutput ? "MAX_TOKENS" : "CONTINUATION";
    const next = finish === "STOP" ? undefined : pack({ h: hash(req), pos: end });
    return { text: words.join(" "), finish, token: next, usage: { prompt, text: words.length, thoughts } };
  }
}

type Run = {
  status: "done" | "raise-cap" | "failed";
  parts: string[];
  token?: string;
  segments: number;
  billed: Usage; // sum of every request: what you pay for
  initialPrompt: number; // what you sent once
  error?: string;
};

// The loop. Same request every time. Only the token changes.
async function longDecode(model: FakeModel, req: Request, maxOutput: number, prev?: Run): Promise<Run> {
  const frozen: Request = structuredClone(req);
  const run: Run = prev
    ? { ...prev, parts: [...prev.parts], billed: { ...prev.billed }, status: "done" }
    : {
        status: "done",
        parts: [],
        segments: 0,
        billed: { prompt: 0, text: 0, thoughts: 0 },
        initialPrompt: count(frozen.contents) + count(frozen.systemInstruction),
      };
  let token = prev?.token;
  let retries = 0;
  while (true) {
    const buffer: string[] = []; // uncommitted until the checkpoint arrives
    let cp: Checkpoint;
    try {
      const it = model.stream(frozen, maxOutput, token);
      let step = await it.next();
      while (!step.done) {
        buffer.push(step.value);
        step = await it.next();
      }
      cp = step.value;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "stream dropped" && retries < 2) {
        retries += 1;
        log(`  drop   discarded ${count(buffer.join(" "))} uncommitted tokens, retry from the same token`);
        continue;
      }
      return { ...run, status: "failed", error: msg };
    }
    retries = 0;
    run.segments += 1;
    run.parts.push(cp.text); // commit only now
    run.billed.prompt += cp.usage.prompt;
    run.billed.text += cp.usage.text;
    run.billed.thoughts += cp.usage.thoughts;
    const note = cp.usage.text === 0 ? "  (thinking only, keep going)" : "";
    log(`  seg ${run.segments}  ${cp.finish.padEnd(12)} prompt ${String(cp.usage.prompt).padStart(3)}  thoughts ${String(cp.usage.thoughts).padStart(2)}  text ${String(cp.usage.text).padStart(2)}${note}`);
    if (cp.finish === "CONTINUATION" && cp.token) {
      token = cp.token;
      continue;
    }
    if (cp.finish === "MAX_TOKENS" && cp.token) return { ...run, status: "raise-cap", token: cp.token };
    return { ...run, status: "done", token: undefined };
  }
}

// What actually sits in the context window after the decode.
const contextSize = (r: Run) => r.initialPrompt + r.billed.text + r.billed.thoughts;
const shouldCompact = (tokens: number, window: number) => tokens >= window * 0.8;

// The two loops people write first.
async function naiveDecode(model: FakeModel, req: Request, maxOutput: number, mode: "ask-to-continue" | "keep-partials"): Promise<string> {
  let r = req;
  let token: string | undefined;
  let text = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const it = model.stream(r, maxOutput, token);
      let step = await it.next();
      while (!step.done) {
        text += (text ? " " : "") + step.value; // straight into the answer
        step = await it.next();
      }
      if (step.value.finish === "STOP") return text;
      token = step.value.token;
      if (mode === "ask-to-continue") r = { ...req, contents: `${req.contents} ${text} Please continue.` };
    } catch (e) {
      log(`  naive  error: ${(e as Error).message}`);
      if (mode === "ask-to-continue") return text;
    }
  }
  return text;
}

const files = Array.from({ length: 150 }, (_, i) => `src/billing/file${i}.ts`).join(" ");
const req: Request = {
  contents: `Plan a safe migration for these files: ${files}`,
  systemInstruction: "You are a careful refactoring agent.",
  tools: ["read_file", "run_tests"],
};
const answer = (
  "Move the shared money helpers into packages/money first and keep the old imports as re-exports. " +
  "Then migrate invoices, refunds, and tax in that order, because refunds import invoices and tax imports both. " +
  "Run the contract tests after each package, not at the end. " +
  "Keep the feature flag off until the refund snapshots match byte for byte. " +
  "Delete the re-exports only after one full release with zero imports from the old path. " +
  "If any step fails, stop, revert that package alone, and report which test broke and why."
).split(" ");
const WINDOW = 1000; // example context window for the demo, not Argon's
const model = () => new FakeModel(40, 60, answer);

const joined = (r: Run) => r.parts.filter(Boolean).join(" ");
const same = (text: string) => (text === answer.join(" ") ? "matches answer" : "WRONG");

async function main(): Promise<void> {
  log("=== Demo 1: the loop, through a thinking-only segment ===");
  const r1 = await longDecode(model(), req, 400);
  log(`  done   ${r1.segments} segments, ${count(joined(r1))} text tokens, ${same(joined(r1))}`);
  log(`  billed prompt (sum of requests) ${r1.billed.prompt}, compact? ${shouldCompact(r1.billed.prompt, WINDOW)}`);
  log(`  actual context ${r1.initialPrompt} + ${r1.billed.thoughts} + ${r1.billed.text} = ${contextSize(r1)}, compact? ${shouldCompact(contextSize(r1), WINDOW)}`);

  log("\n=== Demo 2: 'please continue' changes the request ===");
  const n2 = await naiveDecode(model(), req, 400, "ask-to-continue");
  log(`  naive  stopped with ${count(n2)} of ${answer.length} text tokens`);

  log("\n=== Demo 3: the stream drops mid-segment ===");
  const [m3, m3b] = [model(), model()];
  m3.dropNextStreamAfter(2);
  m3b.dropNextStreamAfter(2);
  const n3 = await naiveDecode(m3, req, 400, "keep-partials");
  log(`  naive  ${count(n3)} text tokens for an ${answer.length}-token answer`);
  const r3 = await longDecode(m3b, req, 400);
  log(`  loop   ${count(joined(r3))} text tokens, ${same(joined(r3))}, ${m3b.requests} requests`);

  log("\n=== Demo 4: the caller's cap runs out first ===");
  const m4 = model();
  const r4 = await longDecode(m4, req, 100);
  log(`  status ${r4.status} after ${count(joined(r4))} text tokens, token kept`);
  const r4b = await longDecode(m4, req, 200, r4);
  log(`  resume ${r4b.status}, ${count(joined(r4b))} text tokens, ${same(joined(r4b))}`);
}

main();
