# OpenRouter Setup for JumboCrab EMIS

Prices and model details checked **October 18, 2026**. Model pricing can change; check the linked OpenRouter pages before choosing.

## Low-cost model to start with

Use **Qwen3.5-9B** with model ID `qwen/qwen3.5-9b`. It supports tool calling used by the scheduling assistant and currently lists at **$0.08 per million input tokens** and **$0.13 per million output tokens**. [Model details and live provider prices](https://openrouter.ai/qwen/qwen3.5-9b/providers).

For scale, one call using 10,000 input tokens and 1,000 output tokens would cost about **$0.00093** at those listed rates. A chat turn can make multiple model calls, so actual cost depends on conversation length and tool use.

If Qwen's tool calls prove unreliable in your own smoke test, try **DeepSeek V4.1 Flash** (`deepseek/deepseek-v4.1-flash`). It supports tool calling across most listed providers, with current listed rates of **$0.13/M input** and **$0.52/M output**. [Model details and live provider prices](https://openrouter.ai/deepseek/deepseek-v4.1-flash/providers).

## Create an API key

1. [Sign in to OpenRouter](https://openrouter.ai/keys). Create an account if needed.
2. Add a small credit balance if your account has none; OpenRouter uses credits for model requests. [OpenRouter getting-started help](https://openrouter.ai/support).
3. On the Keys page, create a key named `JumboCrab EMIS local dev`.
4. Set a small spend limit, for example **$5 per month**, and an expiration if you want one. OpenRouter supports per-key limits and reset periods. [Key limit options](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key).
5. Copy the key when OpenRouter shows it. The plaintext key is shown only once; store it securely.

## Put it in the project

Create or edit **`.env.local` in the repository root** (same folder as `package.json`), then add:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-PASTE_YOUR_PRIVATE_KEY_HERE
OPENROUTER_MODEL=qwen/qwen3.5-9b
OPENROUTER_SITE_URL=http://localhost:3000

# Keep disabled until you intentionally run a local AI scheduling test.
AI_SCHEDULING_ENABLED=false
AI_SCHEDULING_CHAT_ENABLED=false
```

Replace only the placeholder with your key. Do not put the real key in this Markdown file, source code, browser code, or chat. Keep the variable named `OPENROUTER_API_KEY`; **do not** prefix it with `NEXT_PUBLIC_`. The app reads it on the server. This repository's `.gitignore` ignores `.env.local`.

Restart `npm run dev` after changing environment values. The chat route needs both scheduling flags set to `true`; leave them `false` until you deliberately want to make billable local requests as an authorized manager. A disabled chat returns 404. Missing key or model returns 503.

For deployment, add the same variables through your hosting provider's server-side environment/secrets settings. Do not commit `.env.local` or the API key. If a key is exposed, disable it in OpenRouter and create a replacement.

## Links

- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart)
- [OpenRouter API key limits and one-time key display](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key)
- [Next.js environment variables](https://nextjs.org/docs/pages/guides/environment-variables)
