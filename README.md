# Crime Advisor

**Install and guide: https://tornbrain.com**

Every option on Torn's Crimes pages, graded against your own average $/nerve. Worked out from your own crime logs, in your browser.

Read-only: it never clicks, commits a crime or does anything in Torn for you.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for Chrome, Edge or Firefox. In Chrome and Edge, turn on **Allow user scripts** (or Developer mode) for the extension when it asks.
2. Open **https://tornbrain.com/crime-advisor.user.js**: Tampermonkey shows its install page, press **Install**. Installed this way it keeps itself up to date. (Or copy the script from https://tornbrain.com and paste it into a new Tampermonkey script.)
3. Make a key with this link. It opens Torn's key form filled in with your logs and Torn's item prices, nothing else:
   **[Make a key](https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Crime%20Advisor&user=log&torn=items)**
4. On any Crimes page, click **Crime Advisor** in the bottom-left, paste the key and press **Save**.

**Torn PDA:** open the install link in PDA's own browser and press Install. In PDA's script settings, **Set API Key** gives it your Crime Advisor key, so there's nothing to paste.

Your newest logs load first, so grades appear within seconds. Older logs load in the background: about 10,000 logs in 3 minutes, using up to 40 of Torn's 100 calls a minute. It carries on next time you open Torn, and only one tab loads at a time.

## What you'll see

**A grade and one number on every option**, e.g. `S $9.6k/n`. Tap it for the card: what a try pays, the odds, the top items.

| Grade | Meaning |
|---|---|
| **S** | Best on the page, at or above your average |
| **A** | At or above your average across all crimes |
| **B** | Half your average or more |
| **C** | Under half your average |
| **✕** | Loses money |
| **?** | Too few tries to judge yet |
| **⚠** | A trap, e.g. a Flamethrower on an accidental-fire job |
| **★** | Torn shows a one-time unique waiting there now |

**The panel** (the bottom-left button):

| Part | Shows |
|---|---|
| Your avg | Your average $/nerve. Every grade is measured against it |
| Best here | The best options on this page. Tap one to find it |
| Wait for / Better elsewhere | A mark worth waiting for, and crimes elsewhere that beat what's on this page |
| Earn | Your cash crimes, over 30 days or all time |
| Level up | Crimes with skill under 100 |
| Uniques | Skill 100, with uniques left to find |
| Done | The rest |
| Footer | Logs stored, sync status, your key, and "Open automatically on crime pages" |

**The Crimes hub** shows how many uniques each crime has left.

Numbers are net: materials you used are subtracted, and item rewards are counted, both at today's market price. One-time uniques and holiday drops are left out of $/nerve. Scamming includes farming emails and spam waves.

**Without a key**, Arson still works: each job gets the community's recipe and payout range, and its requirements.

## What's new in 2.x

| | |
|---|---|
| Grades | S/A/B/C against your average across all crimes, plus one number. 1.x compared each option with that crime only |
| Best crimes | The best options here, what to wait for, and better crimes elsewhere |
| Your crimes, stacked | Earn, Level up, Uniques, Done |
| More crimes | Shoplifting, Pickpocketing, Burglary by property type (scouting cost counted), Bootlegging's next genre, Card Skimming and Hustling skill plans |
| Item prices | Items count at today's market price. **This needs a new key** (step 3): 1.x keys read logs only, so items counted as $0 |
| Uniques | Left to find, on each crime and the hub |
| Torn PDA (2.1) | Works in the app: on a phone each chip is its grade, and a box beside Torn's chat bar shows the one thing to do |
| Community numbers (2.2) | Opt in to see what players at your skill earn per option (below) |
| Lighter | Faster loading, backs off when Torn is busy, gentler on slow computers, and a reload no longer interrupts it |

**Upgrading from 1.x:** make the new key (step 3) and paste it in under **Key · Change**. Your logs are read once more in the background.

## Community numbers (opt-in)

Off unless you turn it on in the panel's footer. Then each card can show what players at your skill earn there.

| | |
|---|---|
| What's shared | Per crime option: tries (rounded down), success rate, $/nerve, skill band. No logs, no times. Once your history has loaded, at most daily. |
| Your key | Sent once to `api.tornbrain.com`, which asks Torn whose it is, keeps a scrambled id so you count once, and drops the key. |
| What you see | A number only when 5 or more players are behind it. |
| Leaving | Untick it: everything about you there is deleted. |

## Your key and your data

| | |
|---|---|
| Data storage | Only in your browser. Crime logs go into the browser's own storage (IndexedDB); Tampermonkey keeps your settings and key. |
| Data sharing | None, unless you turn on Community numbers (off by default): then coarse per-option summaries go to `api.tornbrain.com`. |
| Purpose of use | Personal: your own $/nerve per crime. |
| Key storage & sharing | Stored in Tampermonkey on this browser (in Torn PDA: on your phone). Sent to `api.torn.com`; if you join Community numbers, once to `api.tornbrain.com`, which doesn't keep it. |
| Key access level | Custom: `log`, plus `items` (Torn section) for market prices. |
| Other downloads | Public arson recipes from `balaclava.app` (the Arsonist's Ledger), once a day. No key is sent with it. |

Each browser keeps its own copy, so a second computer downloads your history again.

## Updating

It updates itself: Tampermonkey checks tornbrain.com for a new version about once a day. Your key and downloaded logs are kept. If you pasted it in by hand, install it once from the link above: Tampermonkey offers it as an update to your copy and it updates itself from then on.

## If something's off

| Message or problem | Fix |
|---|---|
| "This key can't read item prices" | It's a 1.x key. Make a new one (step 3) and paste it under **Key · Change**. |
| "That key doesn't work" | Mistyped, or deleted on Torn. A key is 16 letters and numbers. |
| "too many requests" | Other tools used Torn's 100 calls a minute. It waits and carries on. |
| No grades on a crime page | Grades appear for things you've done before. If the log count is still climbing, give it a few minutes. |
| "loading in another tab" | One Torn tab loads at a time. The others pick up its progress. |
| "logs are re-read each visit" | A private window is blocking storage. It works from your latest ~2,000 logs only. |
| A number looks wrong | Prices are today's, so old items are re-priced. Hover a panel row for all time, 30 days and nerve. |
| Start over | Panel › **Key · Change** › **Remove key and stored logs**. |

---

Made by AJTheSecond. Arson recipes come from the community's Arsonist's Ledger at balaclava.app; your grades and $/nerve come from your own logs.

Free, and staying free. If it's helped you, you can [buy me a coffee](https://buymeacoffee.com/ajthesecond). Entirely optional.
