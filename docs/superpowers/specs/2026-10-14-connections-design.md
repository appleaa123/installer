# Connections: reaching any service with the client's own keys

Status: **draft for the owner's review. No code has been written for this.** Nothing here changes behaviour until the owner approves it. Planned by Opus 5.5 from a read of this repository and of `skills_wiki`; facts checked against official sources on 2026-10-14 are linked, and everything not checked is marked **unverified**.

## 1. Goal and what is already decided

The owner's goal: a non-technical person can connect and link information, data and messages from any channel or service they use, use them in their own workflows, and have AI act as their personal agent that does the work. They install it themselves with an AI helper.

Decided by the owner:

| Question | Decision |
|---|---|
| How much freedom does the agent have? | It asks first; trust is earned per action (the approval levels and earned autonomy that exist today). |
| Order of priority for the first real users | 1. Email inbox, read **and** send. 2. More chat apps. 3. Google Calendar, Drive, Docs. 4. Databases and apps reached with an API key. Eventually all. |
| Where do the client's keys live? | On the client's own computer (the standing rule: client work and keys are never under the owner's account). Hosting keys in Skills Wiki stays an optional idea that must not be required. |
| What if the client's computer is off? | Design for a **spare always-on machine** at the client (the existing "team host" mode). |
| Skills Wiki | Optional (D126). |
| Supabase keys | **Anon key only**, with row-level security. The `service_role` key is refused (decided 2026-10-14). |
| WhatsApp | Build the **minimum**: connect, send and receive (decided 2026-10-14). Design in 5.5. |
| Email as the only chat app | **Not allowed in the first version.** Telegram is always set up and email is an extra, because email cannot prove who sent a message, so approvals and `/pause` could not come by email and would need a terminal every time (decided 2026-10-14). |
| `taskfollow add` | **The helper may run it itself** when the person asks (for example "I now have a new email service to add"); secrets are still entered on the page (decided 2026-10-14). |
| Just you, or a team? | **Ask first.** A single person skips the shared-work and decision-maker questions and the invite-others steps; they are the decision maker by default and only link their own chat once. A team gets the current flow (decided 2026-10-14). |
| Choosing services during install | Ask which service the person uses in each area, and show only the steps for those (requested 2026-10-14). Design in 5.6. |

## 2. What exists today

- One data adapter: Google Sheets (`ADAPTERS = ["google_sheets"]`). A connector is a pinned JSON file; the code that speaks the service's API is the engine's.
- Channels: Telegram and email only (`CHANNEL_IDS`). Email reads message text only; attachments, correct threading and sending attachments are missing.
- Tools a workflow or agent may call: approvals, memos, records, import, channel tools. Nothing can call another API.
- Approval levels are decided by code from the tool, the arguments and field tags, never by the AI (rule R8).
- Google sign-in (OAuth with PKCE on a local page) already works for Sheets and can be reused.

## 3. Skills Wiki's connection service, and what to take from it

Read-only audit of `skills_wiki`:

- A hosted tool `service_bridge.query_connected_service(service, endpoint, method, body, query_params, confirm)` calls a REST API with credentials a client stored in a Supabase table (AES-256-GCM, **one global key**).
- Four hard-coded services (Supabase, GitHub, Notion, OpenAI) plus "custom" (a base URL and a bearer token). **No OAuth, no Gmail/Google/Slack, no way to add a service as data, no proxy to other MCP servers.** Credentials can only be written from the browser dashboard.
- Weaknesses: one decryption key for all clients; a shared process; a hostname-string SSRF check; and the `confirm` flag is set **by the model**, which a prompt-injected model can set. That is exactly what rule R8 forbids.

**Conclusion:** do not route client keys or calls through the hosted bridge by default. **Take its ideas**: one generic call path, services described as data, and its guards (reject absolute URLs in the endpoint, filter response headers, truncate responses, log every call with secrets redacted).

**Skills Wiki's role: the catalog.** Connection definitions are public data. Skills Wiki can serve them; the installer fetches, verifies and pins them; keys and calls stay local. A definition is a capability grant (hosts it may reach, where tokens go, what level an action has), so a poisoned one is dangerous. Therefore definitions are **signed by the owner with an offline key** (ed25519, `node:crypto`, the public key compiled into the engine) and verified before use; bundled definitions come first, so Skills Wiki stays optional. A new host or a lower level in an update needs the decision maker's approval.

## 4. Architecture: a connection is a data file

> **Superseded in part by D136–D139 (2026-10-14).** Services are now reached through the agent's own MCP servers, CLIs and skills, recorded and gated by a hook (D137), instead of connector files TaskFollow ships for each service. The email, chat-app and WhatsApp parts below still apply.

A service is described in a JSON file, pinned by sha256 like connectors today. The engine turns **each declared operation into its own typed tool** named `<id>.<operation>`. The model never supplies a host.

```json
{ "id": "airtable", "version": "1", "name": "Airtable",
  "interface": ["http_service"], "adapter": "http",
  "egress": ["api.airtable.com"], "base_url": "https://api.airtable.com/v0",
  "auth": { "kind": "bearer", "secret_id": "airtable" },
  "operations": {
    "list_records":  { "method": "GET",  "path": "/{base}/{table}", "params": { "base": {"type":"string","pattern":"^app[A-Za-z0-9]+$"}, "table": {"type":"string"} },
                       "paginate": { "cursor_from": "offset", "cursor_to": "offset", "max_pages": 5 },
                       "shape": { "pick": "records[].{id,fields}" }, "tags": { "fields.*": ["personal"] } },
    "create_record": { "method": "POST", "path": "/{base}/{table}", "level": "L2" } },
  "allow_unlisted": false,
  "limits": { "response_bytes": 200000, "timeout_ms": 30000 },
  "risk": { "reads_personal_data": true, "outbound_external": false, "official_api": true },
  "setup": { "…": "the same step-by-step guide block as today" } }
```

**Why typed tools and not one generic `http.call`:** earned autonomy and hardening are tracked per tool. One generic tool would merge every streak and every proposal into one.

**Code or data.** Code (one `http` adapter, about 300 lines plus tests): fill the path from validated parameters (refuse `://`, `..`, `%2f`, `%2e`); check every host against `egress` over https only; refuse redirects; inject the credential from the keychain; follow pagination up to a cap; cap and reshape the response; filter headers; redact before auditing. Also code, kept separate: OAuth refresh (reuse today's), IMAP/SMTP, and anything with unusual framing (Slack and WhatsApp inbound, MIME). Data: endpoints, levels, tags, pagination, response shaping, setup guides, risk.

**Levels stay deterministic (R8).** Level = the highest of: the engine's method floor, the level the definition declares, floor categories, tags on fields written, and the client's own rules. A definition can only **raise** a level. Method floor in code: GET/HEAD may be L0; POST, PUT, PATCH, DELETE are at least L2 (L1 if the operation says it is internal only); DELETE is irreversible, so L3. An endpoint the definition does not list is **refused** (closed world). With `allow_unlisted` it is L2 at least (L3 for DELETE), is off by default and is turned on per connection by a person in their own terminal. The model cannot pass a level.

**Security rules.**
- Fetched data is wrapped as untrusted, scanned for injection, never obeyed (the injection corpus from D117 applies).
- Egress: hosts only from the pinned definition; refuse IP-literal hosts and loopback or private addresses after name resolution. *Trade-off:* Node's `fetch` cannot pin DNS without a dependency; this matters less because hostnames are vetted data.
- Secrets: the OS keychain, one item per connection; never in arguments, results, logs or audit; auth headers are dropped from error text.
- Audit line: tool, level, action hash, host, method, path template, status, bytes, truncated. Never query values, bodies or the secret.
- PII: tags on response and body paths feed the same tag system as the data contract.
- Supabase: **only the anon key**, with row-level security (decided). The `service_role` key bypasses row-level security, so one prompt-injected mistake or one leaked key would expose the whole database. Cost: a client without row-level security rules set up will see nothing or too much, so the setup guide must say how to create them.

**Code that must change first** (`src/core/connectors.ts`): `interface` accepts only `records_source`; the setup validator accepts only `google.com` sources; one secret per connector id; and the adapter list. `connectors/google-sheets/1/` must not change by a byte, or every install's pin breaks. New fields go in new files (`<id>/2`).

## 5. The priorities

### 5.1 Email (first)

IMAP and SMTP stay; the Gmail API is avoided because its read scopes are restricted ([Google's scope list](https://developers.google.com/identity/protocols/oauth2/scopes)).

Today messages are downloaded whole, but only the first plain-text part is kept; a thread breaks on the third reply (it uses `In-Reply-To` and not `References`); and replies are not threaded or given attachments.

Changes: list MIME parts (name, type, size) and store attachment bytes inside the engine home with a size cap and sanitised names; thread on `References`; build multipart messages and let `channel.send` take attachments that are already inside the engine home, with the file's hash inside the approved action so a person approves the **exact file**; an L0 preview tool for text, CSV and PDF text (extracted text is untrusted and scanned; turning it into records goes through the existing import tools at L2, never automatically). Later: other folders, move and flag (these are writes).

**Which email providers work** (answering the owner's question):

| Provider | Works with an app password? |
|---|---|
| Gmail, iCloud, Yahoo, Fastmail, Zoho, AOL | Yes. Built into the setup page (AOL untested; others read from each provider's help pages, none yet tried on a real mailbox: human task 21). |
| Other providers that still offer IMAP with a password (many web hosts, cPanel hosts, small-business mail) | Yes through the page's **Advanced** section, where the person types the server. A custom domain is not yet recognised automatically (a later slice looks up the domain's mail provider). |
| GoDaddy legacy "Workspace Email" | Probably, with GoDaddy's own IMAP/SMTP servers (**unverified**: third-party blogs cite `imap.secureserver.net` and `smtpout.secureserver.net`; check GoDaddy's help). |
| GoDaddy **Microsoft 365** mail, Outlook.com, Hotmail, Live, Microsoft 365 | **No.** Microsoft has [removed Basic authentication](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online) and says [Outlook.com is moving to OAuth only](https://support.microsoft.com/en-us/office/outlook-and-other-apps-are-unable-to-connect-to-outlook-com-when-using-basic-authentication-f4202ebf-89c6-4a8a-bec3-3d60cf7deaef) (the final dates were not confirmed here). The page refuses these and offers Telegram. Supporting them needs Microsoft sign-in (OAuth with XOAUTH2) and, probably, the client registering their own Microsoft app, which is a heavy step for a non-technical person. See question 1. |

### 5.2 More chat apps (second)

One generic definition can cover **sending** for most platforms. **Receiving needs code per platform**, because how new messages are found, how the sender is proven and what the reply window is all differ. The channel contract grows: `attachments` (kinds, size limit), `reply_window` (`none|24h|48h`), `templates_required_after_window`, `inbound` (`long_poll|webhook|socket`), plus `in_reply_to`, `attachments` and `template` on outgoing messages. The fixed list of channels becomes a registry.

- **Slack:** feasible. Polling with `conversations.history` risks Slack's 2025 limits for non-Marketplace apps; Slack says [internal customer-built apps keep their limits](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/), but its own docs disagree on apps created after May 2025. Prefer Slack's push connection (Socket Mode over Node's built-in WebSocket, no public address needed). Settle with one live test.
- **WhatsApp Business:** receives only by webhook, so it needs a public address. The minimum is designed in 5.5.
- **Messenger, WeChat (unverified):** both need an official business account on the platform (a Facebook Page and app review; a verified WeChat account, realistically for a Chinese business entity, or WeCom for internal teams). Rule kept: a channel whose API is not official is never used for outside audiences.

### 5.3 Google Calendar, Drive, Docs (third)

One definition per API with its own keychain item, reusing the person's own Google client and giving each the least scope. [Google lists](https://developers.google.com/identity/protocols/oauth2/scopes) `drive.file` as non-sensitive, `documents` as sensitive, and full Drive and Gmail read as **restricted**. Calendar's classification was **not confirmed**. A personal app that stays unverified works with the warning screen, as Sheets already does. Recommendation: `drive.file` (files the person links) and `calendar.events`; avoid restricted scopes.

### 5.4 Services reached with an API key (fourth)

Pure data on the `http` adapter: Airtable, Notion (bearer token plus a version header), Supabase (anon key and row-level security). A `custom` service (a base URL and auth kind typed on a local page) starts with every operation unlisted, so L2 at least.

### 5.5 WhatsApp, the minimum (decided to build)

Opus checked Meta's official documentation on 2026-10-14 (sources in the table). Items marked **unverified** need one live test.

**Facts**

| Fact | Status |
|---|---|
| Incoming messages arrive only as a **webhook** to a public https address with a valid certificate. No polling or socket option appears in the pages read. | Verified that none is mentioned ([webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview.md)); that none exists is unverified |
| One-time handshake: Meta sends `hub.verify_token` and `hub.challenge`; the address must echo the challenge. Each message carries `X-Hub-Signature-256`, an HMAC-SHA256 of the body keyed with the **app secret**. Meta retries a non-200 answer for up to 7 days, so duplicates happen. | Verified ([endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint.md)) |
| A business may reply freely only within **24 hours of the person's last message**. Outside it, only approved templates can be sent. | Verified ([pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md)) |
| Messages inside the window are free; templates are charged by category and country. A new account may start conversations with 250 people per day until its business is verified. App review and business verification are **not** needed to start. | Verified ([limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits.md)) |
| Since April 2026 a sender may be identified by a business-scoped user id, not a phone number (people who choose a username). | Verified ([BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids.md)); whether sending to such an id works today is unverified |
| The business must own a phone number that can receive a verification call or text and is not already in the WhatsApp app. | Verified |

**Getting webhooks to the assistant (the hard part).** A quick tunnel changes address on every restart; a named tunnel, ngrok or Tailscale Funnel each needs a program, an account and a public listener next to the keychain. None suits a non-technical client. A relay hosted by the owner would pass client messages through the owner's account, which breaks the standing rule. **Recommended: a tiny relay in the client's own free Cloudflare account** (one Worker with a small database), deployed by the installer from one pasted Cloudflare token (the upload endpoint is documented; the workers.dev address step is unverified). The assistant **pulls** from the relay over its normal outgoing connection, the same pattern as Telegram's `getUpdates`, so the computer opens no port and no program is added.

**What the relay does** (about 120 lines in one pinned file): answer Meta's handshake; store each raw body and signature (at most 1 MB each; answer 503 when 5,000 are queued, so Meta's own retry is the back-pressure); hand them to the assistant on request and delete them once acknowledged, and in any case after 72 hours. It never holds the access token or the app secret. **The assistant verifies every signature** and drops (and audits) any message that does not match. **The relay does see message text** for a short time, and so do Meta and Cloudflare; clients should be told.

**Cost to the client:** nothing to start. Two free accounts (Meta, with a business portfolio and developer app; and Cloudflare), about a dozen guided steps. Money starts only when they send templates, which the minimum does not do. Use Meta's test number first.

**Inside the installer**
- WhatsApp becomes a third channel; the fixed list becomes a registry with capabilities (`inbound: relay_poll`, `reply_window: 24h`, sender verified). About ten places that name a channel today become capability lookups.
- One keychain item holds the access token, the app secret and the pull token; the relay address and phone number id are saved as settings. A guided page (`taskfollow secret whatsapp`, same style as the email page) deploys the relay, takes the Meta details, and waits for one real signed message before it says Connected.
- A member joins by sending the invite code in a message, as with the other channels, and a reply link is printed for them. The sender's phone number or user id is the identity.
- **The 24-hour rule is the biggest effect.** Sending to a WhatsApp contact outside the window is refused **before** an approval is asked, with a plain sentence: ask them to message you on WhatsApp, or use another channel. Approval announcements to a member outside the window fall back to their other channel before the item is claimed, so none is lost. Templates are not in the minimum.
- Approvals, consent, quiet hours, rate limits and the audit do not change. New audit events: `channel.signature_rejected` and `channel.window_closed`.

**Tests first (fakes only):** relay contract (handshake, size cap, full queue, bad token, acknowledgement, 72-hour expiry, run from the real relay code under a small HTTP shim); signature checks (accepted, altered, missing); inbound parsing (text kept, delivery statuses and media dropped, user-id-only sender, duplicate message collapsed); the 24-hour window at 23:59 and 24:01; send error mapping with the token never in an error; join; page and deployer. A fake Meta server and a fake Cloudflare record what is sent.

**Slices:** (1) channel registry, no behaviour change; (2) relay and its contract tests; (3) Meta client, signature check, inbound, connector; (4) the 24-hour gates and the announcer fallback; (5) deployer and setup page; (6) joining, INSTALL.md, doctor, support bundle.

**A human must check with a real number:** which switch makes the app "Live" and what it demands; whether the callback registers at once; the test number's recipient list; a real message arrives with a matching signature; a send inside the window works and one past 24 hours is refused by the engine; a username-only sender arrives; whether a token that never expires can be chosen; whether a card is needed for a real number; whether a brand-new Cloudflare account can serve a workers.dev address.

### 5.6 Choosing services during the install (requested)

**Experience.** Right after the decision-maker question, the helper asks one plain question per area where there is a real choice. Two for the starter: "Which apps should your assistant use to message you and your team?" (Telegram, Email; more than one allowed) and "Where do you keep your contact list?" (Google Sheets, or not now). If the person is unsure, the helper explains each option in a sentence and, if still unsure, uses a safe default and says it can change later. If they name something not available (Outlook, WhatsApp until it ships), the helper says so and that it can be added later; free text is never guessed into an option. Then the helper says once what they will need on hand, and the install shows only the steps for what was chosen ("5 of 17 steps").

**Engine.** A step may carry `when: { step, includes | equals }` pointing at an earlier question. The question is an ordinary `ask` step; its answer is stored as an ordinary step record; which steps are visible is computed from those answers every time and never stored. The pinned solution text is unchanged, so its hash is stable, and installs made before this keep working exactly as they do (they have no `when`). Hidden steps are never written as skipped. Compared and rejected: expanding steps from a catalog at install time (install steps would depend on bytes outside the pinned text; revisit when there are three or four services), and composing several small solutions (the pin, state and report all assume one).

**Adding a service later.** `taskfollow add email` writes the new answer, reveals that service's steps, and the install returns to "in progress" until they are done. The gateway reads its channels only when it starts, so adding a channel ends with a restart step. A service the installed solution does not list cannot be added this way (that needs a solution upgrade path, which does not exist yet).

**Tests first:** a hidden step stays hidden and is refused if addressed; the current step skips what was not chosen; resume never reopens a hidden step; the total counts visible steps; a revised answer leaves the pinned hash alone; an old install still completes unchanged; the scripted operator needs an answer for each question.

**Slices:** (1) `when`, visibility, report totals and the contact-list question (the smallest useful slice); (2) the chat question, the email steps and the gateway restart; (3) `taskfollow add` and the "can add" line in the report; (4) catalog-driven expansion later.

**One thing this opens up:** the same mechanism can ask "just you, or a team?" and hide the decision-maker, invite and team-channel steps for a single person. That is a scope decision for the owner (section 10, question 8).

## 6. If the computer is off

Decided: a spare always-on machine, using the existing team-host mode (Mac or Linux; Windows has no boot service). In personal mode, while the computer sleeps: the gateway stops (the next tick restarts a stale one after a reboot, D130); a schedule more than 5 minutes late is recorded as missed and never run late, with a "back online" notice on return; **Telegram [discards updates older than 24 hours](https://core.telegram.org/bots/api)**; email loses nothing (it resumes from where it stopped); webhook senders retry by their own rules (**unverified**). A small cloud machine the client rents is possible later but needs a decision on keeping keys in an encrypted file there (the file keychain is tests-only today).

## 7. Roadmap (each slice test-first, fakes only, no real accounts)

| # | Slice | Tests written first | Size |
|---|---|---|---|
| 1 | Email in: attachments, correct threading | `mime-attachments`, `email-threading`, injection corpus on attachment text | M |
| 2 | Email out: attachments with the file's hash in the approved action | `smtp-multipart`, refusal of paths outside the engine home | S–M |
| 3 | Slack channel (push) and the channel contract additions | `slack`, a fake Slack, channel contract checks | M |
| 4 | Connections core: schema v2, `http` adapter, generated tools, method floor | `connections` (parse, pin, floor, unlisted refused, levels only raised), `http-call` (template injection, egress, private addresses, redirects refused, truncation, audit redaction), a fake REST server | M–L |
| 5 | Google Calendar and Drive on the core | extended Google auth tests; definitions against the fake Google | M |
| 6 | Key-based services: Airtable, Notion, Supabase | definition fixtures against the fake REST server | S each |
| 7 | Signed catalog fetch from Skills Wiki | bad signature rejected; a new host needs approval | M |
| 8 | WhatsApp, minimum (six slices in 5.5) | relay contract, signature, 24-hour window, join | L overall |
| 10 | Choosing services during install (four slices in 5.6) | hidden-step, resume, report, old-install tests | S–M each |
| 9 | Microsoft sign-in for Outlook and Microsoft 365 mail | XOAUTH2 against a fake server | M, if the owner wants it (question 1) |

## 8. What will not change

`connectors/google-sheets/1` and its pin; existing channel config and cursor files (fields are only added); the human-only decision surfaces; certified runtime paths; existing tool names and levels; installs without a data contract.

## 9. Riskiest assumptions

1. Pagination and response shaping can express real services without per-service code. Settle it by writing the Airtable, Notion and Supabase definitions first and counting the special cases.
2. Vetted hostnames make DNS pinning unnecessary. Settle it with a threat review.
3. Slack fits its limits. Settle it with one live test, or use Socket Mode.

## 10. Questions for the owner (recommended answer in brackets)

Already decided: webhook channels go through a relay (WhatsApp minimum, 5.5); Supabase uses the anon key only; no email-only installs in the first version; the helper may run `taskfollow add`; the install asks "just you, or a team?" first. The five questions below remain open but do not block the picker or the email slices.

1. **Outlook / Microsoft 365 mail:** build Microsoft sign-in (slice 9) even though the client probably needs to register their own Microsoft app? [Not now: offer Telegram or another mailbox, and decide after the first real users ask.]
2. **The WhatsApp relay** lives in the client's own free Cloudflare account and holds message text for at most 72 hours. Acceptable? [Yes. No owner-hosted option.]
3. **WhatsApp templates** (writing to someone first, or after the 24 hours): leave out of the minimum? [Yes: block with a plain sentence; add a utility template later.]
4. **Custom services with unlisted endpoints at L2:** allow, off by default, enabled per connection from the person's terminal? [Yes.]
5. **Who signs catalog definitions?** [The owner only, with an offline key.]
