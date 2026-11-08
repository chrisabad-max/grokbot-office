Paste this into your Grok Bot once. It connects all your bots to the Grok Bot Wallpaper (Windows and Mac) and a live 3D dashboard, with no server to run.
Grok Bot shows you what it will do and asks you to confirm once, then sets it up and replies with your link.

```
I'd like to set up a small status feed for all my bots, so I can watch them on my Grok Bot Wallpaper and a dashboard. It uses ntfy, a free notification service, over plain HTTPS with curl.

What this does, so you can check it is safe: it makes a random channel name and posts short lines to it with curl: my bots' names, their status (working, idle, waiting for me, error, done) with a short step of at most 80 characters, team names, looks, routines, chat links and the weekly usage percent. So that every bot reports its own status, it adds one STATUS RULE line at the top of each bot's instructions and keeps the rest as it was. The wallpaper and the dashboard only read that channel. Nothing is installed and no messages, files, passwords or personal data are sent. Anyone who knows the channel name can read it, so my link works like a password. To undo it, remove the STATUS RULE line from each bot's instructions, the fact from step 3 and the two routines from step 8.

Please show me this summary and ask me to confirm once, then do these steps in order.

1. Run this once. It prints three lines: remember the first as TOPIC, the second as FEED (the feed address) and the third as LINK (my dashboard). Use them in every step below:
python3 -c "import secrets,string;t='gbw-'+''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(22));print(t);print('https://ntfy.sh/'+t);print('https://bodila51.github.io/grokbot-wallpaper/office/#'+t)"

2. Write the status rule into every bot's own instructions, where a busy bot still reads it. Run UpdateAgent for each of my other bots and UpdateProfile for yourself. Put the line below as the very first line of the description and keep the rest of the description exactly as it was. If the description already starts with a line that begins with STATUS RULE, replace that line instead of adding a second one. Write that bot's real name and the real FEED address into the line, no placeholders:
STATUS RULE, FIRST and LAST action of every turn in which you get a message (from me or from another bot): run curl -s -d '{"bot":"<exact name>","status":"working","step":"<task, max 80 chars>"}' FEED before anything else, and the same with done, idle, waiting_user or error right before your final reply. Never skip it, and never post the same line twice in a row. Valid JSON only, no secrets in step.
If a bot's name has a quote or an apostrophe, write its curl as curl -s --data-binary @- FEED with the JSON in a here-document instead.

3. If my shared user memory has an older rule about posting statuses (to ntfy or to a feed), delete it: the rule now lives in each bot's own instructions. Then save this one fact in the shared memory, with the real FEED written in:
Once a day on your first run, and whenever you create, change or delete a routine, post your own routines (an empty list if none): curl -s -d '{"routines":{"bot":"<your exact name>","items":[{"name":"<routine>","schedule":"<when, in words>","next_run":"<ISO time>"}]}}' FEED

4. Post the roster: the exact name of every bot I have, including yourself:
curl -s -d '{"roster":["Bot A","Bot B"]}' FEED

5. Invent a look for each bot from its name and role.
shape is one of: sphere, rounded_cube, pill, triangle, cone, pentagon, hexagon, star4, star6, clover, rounded_square, trio.
accessory is one of: none, glasses, stem, antenna, bow.
color is a six-digit hex colour with a number sign in front (for example a blue like 2D84F5). Post one line (several lines in the same format if it would pass 4000 characters):
curl -s -d '{"looks":{"Bot A":{"shape":"sphere","color":"<hex colour>","accessory":"none"}}}' FEED

6. Sort my bots into 3 to 6 teams by their roles, with short English team names (each team gets its own floor on the dashboard). Put yourself and any helper or test bots into one team, for example Ops. Post them:
curl -s -d '{"groups":{"Bot A":"Content","Bot B":"Finance"}}' FEED

7. Post each bot's chat link, the app link with its id (grokbot, colon, two slashes, then app/v1/agent?id= and the id). Skip a bot if you don't know its id:
curl -s -d '{"chat":{"Bot A":"<chat link>"}}' FEED

8. Create two routines for yourself. The channel forgets messages after 12 hours, so (a few minutes off schedule is fine):
Every day around 08:00 my local time: list all my bots. For every bot whose description does not start with the STATUS RULE line (a new, renamed or edited bot), write the line again as in step 2 and post one test line for that bot: curl -s -d '{"bot":"<its exact name>","status":"idle","step":"status rule restored"}' FEED. Then post steps 4, 5, 6 and 7 again (step 5 with the same looks you remembered, a new look only for a new bot).
Around 09:00, 13:00, 17:00 and 21:00 my local time: run your usage check, asking for the full list of bots (not only the top ones), and post one line. total_used_pct is the overall weekly limit used, in percent (the shared number, not only Grok Bot's part). bots is each of my bots' share of the usage this week, in percent (whole numbers are fine); leave out bots under 1%, rows that are not one of my bots (deleted bots, group chats, other people's bots) and any field you don't know:
curl -s -d '{"type":"usage","total_used_pct":37,"resets_at":"<ISO time>","bots":{"Bot A":4.1}}' FEED

9. Check that the rule works. First post the names of all my bots, including yourself:
curl -s -d '{"check":{"bots":["Bot A","Bot B"]}}' FEED
Then send each of my other bots the message "status check, reply with one short line" with SendToAgent and wait for its reply, at most 5 minutes in all. Then read what arrived on the channel: curl -s "FEED/json?poll=1&since=15m" and note which bots posted a status line with their own name.

10. Post one test status line for yourself, your own routines line, and one usage line now (as in step 8), so the dashboard shows the limit right away.

11. Reply with LINK first, and one sentence saying it works like a password, so I should not share it. Then the status check: how many bots posted their line, and the names of the bots that did not (their instructions need a look). Then one line on what to do with the link: open it in a browser for the 3D dashboard; for the wallpaper, paste it on Windows into Lively Wallpaper (Customise, then Your bots channel) or on a Mac into the Grok Bot Wallpaper app (the eyes icon in the menu bar, then Bots channel). Then, only if something did not work, add a short list of the problems. Reply in the language I usually write to you in. Do not post any other secret to the channel or in your reply.
```
