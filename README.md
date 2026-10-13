# tiny-continuation-loop

A tiny client-side continuation loop for long decodes, in one TypeScript file.
It resends the same request with the latest continuation token, commits text only when a checkpoint arrives, retries a dropped stream from the last good token, hands back the token when the caller's cap runs out, and counts the real context separately from summed input tokens.
The model is fake and one word counts as one token. No API key. No network.

## Why it matters

Gemini 4 Argon (released October 13, 2026) can generate past a single request's output limit. The API returns `finish_reason=CONTINUATION` and a `continuation_token`, and you resend the original request with it.
Google's docs warn that summed input tokens grow on every continuation and are not your context size.
This is a small model of that idea. It is not how Gemini or the Google Gen AI SDK works inside.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npx tsx continuation.ts
```

## Example output

See `output.txt`. Segment size, window size, prompt, and answer are example inputs.

## License

MIT

## Write-up

- Dev.to: https://dev.to/bobbyhalljr/google-launched-gemini-4-argon-lets-build-a-tiny-continuation-loop-in-typescript-5248
- Substack: https://bobbyhalljr.substack.com/p/google-launched-gemini-4-argon-lets
