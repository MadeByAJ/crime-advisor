# Crime Advisor

**Install and guide: https://tornbrain.com**

A Torn userscript for the Crimes pages. A small button next to every arson job, scam, search spot and shop shows what that crime has paid **you** per nerve, from your own crime logs. Click the button for the full card: your history with it, the job's requirements, and the community's arson recipe.

Read-only: it never clicks, commits a crime or does anything in Torn for you.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for Chrome, Edge or Firefox. In Chrome and Edge, turn on **Allow user scripts** (or Developer mode) for the extension when it asks.
2. Open **https://tornbrain.com/crime-advisor.user.js**: Tampermonkey shows its install page, press **Install**. Installed this way it keeps itself up to date. (Or copy the script from https://tornbrain.com and paste it into a new Tampermonkey script.)
3. Make a log-only API key with this link, which opens Torn's key form pre-filled:
   **[Make a log-only key](https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Crime%20Advisor&user=log)**
   Check it lists only **log**, create it and copy the key. (Torn's own form has no Custom option, so the link is the way to get one.)
4. On any Crimes page, click **Crime Advisor** in the bottom-left corner, paste the key and press **Save key**.

Your newest logs load first, so buttons appear within a few seconds. Older logs then load in the background at 100 logs every 3 seconds: about 5 minutes per 10,000 crime logs, roughly 20 of Torn's 100 calls a minute. The numbers update every 2,000 logs as it goes. It carries on where it stopped next time you open Torn, and only one tab downloads at a time.

A Limited key won't work: Torn only shows crime logs to keys with log access. A Full key works but gives the script more than it needs.

## What the buttons mean

| Button | Meaning |
|---|---|
| **Green** | Worth it: above your usual for that crime and above your average across all crimes. |
| **Amber** | Beats your usual for that crime, but your other crimes pay better per nerve. |
| **Grey** | Below your usual, too little history to judge, or new to you (the card then shows the community's numbers). "lost money" means materials cost more than it paid. |
| **Red** | An arson job that needs total destruction and stopped short of 100%. It won't pay. |

On the Disposal page each job's button also names the method with the best expected $/nerve (`$19k/nerve · abandon`); its card rates every method by reliability, nerve and expected value, with a dot on each method's icon where Torn labels them. Graffiti is valued by district.

The **Crime Advisor** button in the bottom-left opens a panel with your key, how far the download has got, and your $/nerve per crime, all time and for the last 30 days.

Numbers are net: materials you used (fuels, candles, email lists) are subtracted and item rewards counted, both at today's market price. Scamming includes the nerve spent farming emails and sending spam waves.

### Without a key

Arson still works: each job gets a button with the community's payout range and recipe (what to place, what to ignite with, when to stoke), the job's requirements, and a red warning on a job that needs 100% and topped out short.

## Your key and your data

| | |
|---|---|
| Data storage | Only in your browser. Crime logs go into the browser's own storage (IndexedDB); settings and your key are kept by Tampermonkey. |
| Data sharing | None. Nothing about you leaves your browser. |
| Purpose of use | Personal: your own $/nerve per crime. |
| Key storage & sharing | Stored in Tampermonkey on this browser. Sent only to `api.torn.com`. |
| Key access level | Custom, with `log` only. |
| Other downloads | Public arson recipes from `balaclava.app` (the Arsonist's Ledger) and item prices from Torn, each refreshed once a day. No key is sent with the recipe download. |

Each browser keeps its own copy, so a second computer downloads your history again.

## What's new in 1.2.0

- **Disposal works for every job.** Only Broken Appliance and Firearm got a button before: the logs say "abandoning *some* general waste", and the script didn't match that to the page's General Waste.
- **Which disposal method to use.** Each job's button names the method with the best expected $/nerve, and its card rates every method: how reliable it is (colour), the nerve it costs, the expected $/nerve and your critical fails. Reliability starts from the community's disposal chart (Feb 2024, 35,517 disposals) and follows your own results as you build history. Cheap and shaky can beat sure and dear: abandoning a dead body (6 nerve, ~80%) usually beats burning it (10 nerve, ~90%), which is why veterans leave them.
- **Newer forgery projects are counted.** Steps like holographing a Travel Visa, programming or chipping an ID Badge, casting or polishing a Skeleton Key, framing, branding and gluing weren't recognised: their nerve was left out, so Forgery read higher than it should.
- **Bootlegging's online store is counted.** Setting up the store and collecting its funds were left out, so Bootlegging read lower than it should.
- **Graffiti by district.** Each district on the Graffiti page gets its own button.

Your stored logs are re-read with the new rules, so nothing needs re-downloading: paste the new version over the old one.

## Updating

It updates itself: Tampermonkey checks tornbrain.com for a new version about once a day. Your key and downloaded logs are kept. If you pasted it in by hand, install it once from the link above: Tampermonkey offers it as an update to your copy and it updates itself from then on.

## If something's off

- **"the key can't read logs"**: the key has no log access. Use **Make a log-only key** in the panel and paste the new key with **Replace key**.
- **"the API key isn't right"**: the key was mistyped or deleted on Torn. It's 16 letters and numbers.
- **"too many requests: waiting"**: other tools used up Torn's 100 calls a minute. The script waits a minute and carries on.
- **No buttons on a crime page**: buttons only appear for things you've done before (or community arson jobs). If the panel's log count is still climbing, give it a few minutes. Check Tampermonkey shows the script enabled on torn.com.
- **"your logs are re-read each visit"**: the browser is blocking storage, usually a private window. It then works from your most recent ~2,000 logs only.
- **A number looks wrong**: prices are today's market values, so old materials and rewards are re-priced. Crimes where the money lands on a later step than the nerve (card skimming, for one) are valued as a whole crime.
- **Start over**: panel > **Remove key and data** clears your key and every stored log from this browser.

---

Made by AJTheSecond. Arson recipes come from the community's Arsonist's Ledger at balaclava.app; the numbers on your buttons are from your own logs.
