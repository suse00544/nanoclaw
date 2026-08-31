## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` displays structured content and moves on.

### Asking a multiple-choice question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, options, timeout? })` presents the user with a set of choices and **blocks your turn** until they tap one or the timeout expires (default: 300 seconds). Returns their chosen value.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:

- `label` — the button text shown before selection
- `selectedLabel` — the text shown on the button _after_ selection (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision. For free-text input, send a normal message and wait for their reply — don't reach for this tool.

Call it **once** for a decision, then wait for the returned value. A successful tool result means the user clicked an option; continue from that value without asking whether the card was visible. If delivery fails, the tool returns an explicit error or timeout. Do not send test cards or retry merely because the user has not answered yet.

Keep cards compact: a short title, one concrete question, and 2–5 mutually exclusive options. Prefer plain strings unless your workflow needs a stable machine value or a clearer post-click `selectedLabel`.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (nested text or content blocks), and `actions` (buttons). `fallbackText` is sent as a plain message on platforms without card support.

Use this for presenting information in a cleaner format than prose: summaries, read-only results, or results with URL buttons. Non-URL actions cannot return a value and may be omitted by the channel adapter. If you need the user to choose something, always use `ask_user_question` instead.

`send_card` queues a card for asynchronous platform delivery. Its returned ID is not proof that the platform rendered the card. Never probe card schemas, send platform-native JSON (`header`, `elements`, etc.), or repeatedly retry from inside the agent; report the delivery error if one is returned and continue with a normal text message when appropriate.
