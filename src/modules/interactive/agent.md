## ask_user_question

Use `ask_user_question` when you need the user to pick from a small set of concrete options and you can't infer a reasonable default. This is a **blocking** call — your turn pauses until the user clicks or the timeout expires.

**When to use:**

- Confirming a destructive action ("Delete these 3 files?")
- Choosing between incompatible paths ("Keep their version or yours?")
- Gathering a required parameter that must be one of a known set

**When NOT to use:**

- Open-ended text input — just send a regular message asking.
- Yes/no confirmations where "no" is the safe default — just proceed and let the user interrupt.
- Anything you can work out from context.

**Arguments:**

- `title` (string) — short card header, e.g. "Confirm deletion"
- `question` (string) — the full question
- `options` (array) — each is either a plain string or `{ label, selectedLabel?, value? }`. `selectedLabel` replaces the button text after click; `value` is what gets returned to you
- `timeout` (number, seconds, default 300) — how long to wait before giving up

The response is the `value` (or label if no value set) of whichever option the user chose. On timeout you get an error and should proceed with a sensible default or tell the user you timed out.

**Interaction discipline:**

- Ask one compact question with 2–5 mutually exclusive options, then wait.
- Call `ask_user_question` only once for the same decision. Do not send test cards while waiting.
- A returned value means the click succeeded. Continue from it; do not ask whether the card was visible.
- Never use `send_card` to collect a choice. It is display-only and non-URL buttons have no response path.
- Never invent or test platform-native card JSON. NanoClaw's channel adapter owns platform rendering.
