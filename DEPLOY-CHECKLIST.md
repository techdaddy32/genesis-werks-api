# FHI Work Order backend — deploy checklist

Keep this next to `deploy.bat`. Do the numbered steps in order. You only do the one-time
setup (Steps 2–4) once; after that, shipping a change is just `deploy.bat`.

## How to open a command window
Press the **Windows key**, type `cmd`, press **Enter**. In that black window, paste with
**right-click** (or Ctrl+V). Use Command Prompt, NOT PowerShell (the blue window).
First, point it at this folder — paste this and press Enter:

```
cd /d "B:\Multiverse\craig-universe\spaces\business\ventures\lv-plan-analyzer\dev-projects\service-work-orders\backend"
```

## 1. First deploy
Double-click **deploy.bat**. When it finishes, find the line in the output like
`https://fhi-service-wo.xxxxx.workers.dev` and copy it — that's your Worker URL.

## 2. Set the PDF link base (one-time)
Open `wrangler.toml`, find the line:
`# PUBLIC_WORKER_URL = "https://fhi-service-wo.<subdomain>.workers.dev"`
Delete the leading `# ` and replace the URL with the one from Step 1. Save.

## 3. Set the secrets (one-time)
In the command window (see top), run each of these. After each one it asks you to paste a
value — paste it and press Enter.

```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLIQ_DAILY_WEBHOOK
npx wrangler secret put CLIQ_MATERIALS_WEBHOOK
npx wrangler secret put CLIQ_SCHEDULING_WEBHOOK
```

- **ANTHROPIC_API_KEY** — your Anthropic key (see "Getting the Anthropic API key" below). Powers
  the "Generate invoice notes" button.
- **CLIQ_DAILY_WEBHOOK** — paste:
  `https://cliq.zoho.com/company/705870557/api/v2/channelsbyname/dailyreports/message?zapikey=YOUR_TOKEN`
- **CLIQ_MATERIALS_WEBHOOK** — paste:
  `https://cliq.zoho.com/company/705870557/api/v2/channelsbyname/materialsneeded/message?zapikey=YOUR_TOKEN`
- **CLIQ_SCHEDULING_WEBHOOK** — the #Scheduling channel (tentative-appointment notices). Paste:
  `https://cliq.zoho.com/company/705870557/api/v2/channelsbyname/scheduling/message?zapikey=YOUR_TOKEN`

(For the two Cliq ones, `YOUR_TOKEN` is your Cliq webhook token. Regenerate it in Zoho Cliq if the
old one was ever shared in chat.)

## 4. Deploy again
Double-click **deploy.bat** to apply the URL + secrets. Done with one-time setup.

## Everyday: shipping a change
Just double-click **deploy.bat**. That's it.

---

## Getting the Anthropic API key
This is a separate pay-as-you-go account from your Claude subscription — it's what lets the Worker
call AI for the invoice-notes feature. Cost is tiny (fractions of a cent per note on the default
model).

1. Go to **https://console.anthropic.com** and sign in (or create an account).
2. Add a payment method / credits: **Settings → Billing**. Prepaid credits are fine; a small
   amount lasts a long time at this usage.
3. Create the key: **Settings → API keys → Create key**. Name it something like "FHI Work Orders".
4. **Copy the key immediately** (it starts with `sk-ant-...` and is shown only once).
5. Paste it when `npx wrangler secret put ANTHROPIC_API_KEY` prompts you (Step 3 above).

If you skip this, everything else still works — only the "Generate invoice notes" button will
return a "not configured" message until the key is set.

## Quick test after deploy
- Complete "Work Order Tasks" on a WO in the app → it should close and move to billing.
- Log hours + request a part → check they save and the part posts to #materialsneeded.
- Add daily-report entries → "Send daily report" → PDF link + post in #dailyreports.
- Open a WO summary PDF and try "Generate invoice notes".
