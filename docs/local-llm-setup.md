# Run a Local AI Coding Helper Alongside Claude Code (Save Tokens)

This guide sets up a **free local model on your dev PC** that takes over the cheap, simple
coding tasks, so you spend fewer Claude tokens. Claude still handles the hard stuff.

> **Important reality check:** You cannot run **GLM-5** itself on a normal gaming PC. As of
> mid-2026 GLM-5 is the strongest *open* coding model, but it's a data-center-scale model and
> needs many high-end GPUs. What you **can** run at home is a smaller, very capable coder —
> **Qwen3-Coder** — and let a router send only the easy work to it. That's the realistic way
> to "run a local model alongside Claude to save tokens."

This is a **development-machine setup only**. It does **not** change the O'Neil Beats backend
or anything on Vercel. Nothing here gets deployed.

---

## How it works (the 30-second version)

```
            ┌──────────────────────────┐
  you type  │   claude-code-router     │
  in your   │  (decides per-request)   │
  terminal  └───────────┬──────────────┘
                        │
        simple / cheap  │  hard / planning / big context
                        ▼                 ▼
              ┌──────────────┐   ┌──────────────────┐
              │  Ollama on   │   │  Claude (cloud)  │
              │  YOUR PC     │   │  = me, as today  │
              │ Qwen3-Coder  │   │                  │
              │  (FREE)      │   │  (uses tokens)   │
              └──────────────┘   └──────────────────┘
```

- **claude-code-router (CCR)** is a small free program that sits in front of Claude Code.
- It looks at each request and routes it: throwaway/simple tasks → your local model (free),
  real coding/planning → Claude.
- You launch with `ccr code` instead of `claude`. Everything else feels the same.

---

## Step 0 — Check your graphics card (1 minute)

Which model size you pull depends on your GPU's **VRAM** (video memory).

**Windows:** Press `Ctrl+Shift+Esc` → **Task Manager** → **Performance** tab → click **GPU**.
Look at **"Dedicated GPU memory."**

| Your VRAM        | Pull this model            | Notes                                    |
|------------------|----------------------------|------------------------------------------|
| 16 GB or more    | `qwen3-coder:14b`          | Best quality you can run locally         |
| 8–12 GB          | `qwen3-coder:7b`           | The sweet spot for most gaming PCs       |
| Under 8 GB       | `phi4-mini`                | Lighter; fine for autocomplete + simple Q&A |

If you're unsure, start with `qwen3-coder:7b` — it runs on almost any modern gaming PC.

---

## Step 1 — Install Ollama (runs the local model)

1. Go to **https://ollama.com/download** and install for Windows.
2. After install, open a terminal (PowerShell) and download your model — pick the line that
   matches your VRAM from the table above, for example:

   ```bash
   ollama pull qwen3-coder:7b
   ```

3. Quick test that the model works:

   ```bash
   ollama run qwen3-coder:7b "write a JS function that reverses a string"
   ```

   If it prints some code, you're good. Type `/bye` to exit.

---

## Step 2 — Install Claude Code + the router

You need Node.js first (https://nodejs.org — install the LTS version). Then:

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @musistudio/claude-code-router
```

---

## Step 3 — Add the router config

Copy the example file from this repo:

- **`docs/claude-code-router.config.example.json`**

to this location on your PC (create the folder if needed):

- **Windows:** `C:\Users\<your-name>\.claude-code-router\config.json`

Then open it and:

1. Put your Anthropic API key where it says `PASTE_YOUR_ANTHROPIC_KEY_HERE`
   (get it from https://console.anthropic.com/settings/keys).
2. If you pulled a different model size in Step 0 (e.g. `qwen3-coder:14b`), change the two
   places that say `qwen3-coder:7b` to match.

---

## Step 4 — Use it

Instead of running `claude`, run:

```bash
ccr code
```

That launches Claude Code through the router. Work exactly like you do now. Behind the
scenes, simple tasks quietly go to your local model for free, and the heavy lifting goes to
Claude.

To confirm the local model is actually being used, open a second terminal and run:

```bash
ollama ps
```

If you see `qwen3-coder` listed as running while you work, the local routing is live.

---

## What goes local vs. what stays on Claude (set your expectations)

A 7B–14B local model is good, but it is **not** as smart as Claude on hard problems. The
config is tuned so you get savings without hurting quality:

| Goes to your **local model** (free)        | Stays on **Claude** (worth the tokens)         |
|--------------------------------------------|------------------------------------------------|
| Autocomplete & boilerplate                 | Multi-file debugging                           |
| "What does this function do?"              | Architecture / design decisions                |
| Small, single-file edits                   | Anything touching the live O'Neil Beats backend |
| Summarizing a diff / quick formatting      | Planning a feature, tricky logic               |

**Rule of thumb:** this saves tokens on the easy ~30–40% of work. For anything important or
confusing, let it use Claude — the router does this automatically, but you can also force
Claude in a session by typing `/model default` inside CCR.

---

## Troubleshooting

- **`ccr: command not found`** → re-run the `npm install -g @musistudio/claude-code-router`
  line, then close and reopen your terminal.
- **Local model never seems to run** → make sure Ollama is open/running and that the model
  name in `config.json` exactly matches what `ollama list` shows.
- **Local model is slow** → you pulled too big a model for your VRAM. Drop from `:14b` to
  `:7b` (or `phi4-mini`).
- **Want everything back on Claude temporarily** → just run `claude` instead of `ccr code`.

---

## Not covered here (on purpose)

- We are **not** hosting GLM-5 locally — it's too large for a gaming PC.
- The backend's own AI features (beat titles, descriptions, cover prompts) run on Vercel and
  are **not** affected by this. Routing those to a cheaper/local model is a separate project
  (it would need a way to reach your PC from the cloud). Ask if you want to explore that later.
