# Claude API Chat

A small chat page that talks to Claude through your own Anthropic API key, so it spends API credits instead of plan usage. Pick any model (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, or anything your account can see), set the effort, attach images, PDFs and text files, and see what each reply cost.

Everything runs in your browser:

- Your API key, your chats and your memory pack are stored only on the device you use, never in this repo or on a server.
- Messages go straight from the page to `api.anthropic.com`.
- The page's security policy only lets it talk to `api.anthropic.com`.

## Using it

1. Open the site and paste an API key from the Claude Console (Settings → API keys).
2. Optional: import a memory pack (a plain-text file of notes about you) under Settings → Memory. Claude reads it when it's relevant.
3. On iPhone, tap Share → Add to Home Screen so it opens like an app and keeps your key and chats.

If the phone locks or you switch apps while a reply is coming in, the reply picks back up when you come back. The screen stays on while a reply streams. Busy-server errors and connection blips are retried on their own before anything shows as failed.

## Editing

It's three plain files: `index.html` (layout), `style.css` (looks) and `app.js` (everything else). The model list and prices are at the top of `app.js`. Edit on GitHub and the site updates in a minute or so.
