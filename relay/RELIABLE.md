For people who connected their bots with the earlier prompt: paste this into Grok Bot once. It keeps the same feed and
dashboard link, moves the status rule into every bot's own instructions (busy bots skip the shared memory), adds a daily
check that puts the rule back, and checks every bot now. Like the setup prompt, it has no links or hashtags.

```
Please make my bots' status feed reliable. Use the same FEED address as before: it is in the status rule in my shared memory (the address the curl lines post to). Do these steps in order.

1. Write the status rule into every bot's own instructions, where a busy bot still reads it. Run UpdateAgent for each of my other bots and UpdateProfile for yourself. Put the line below as the very first line of the description and keep the rest of the description exactly as it was. If the description already starts with a line that begins with STATUS RULE, replace that line instead of adding a second one. Write that bot's real name and the real FEED address into the line, no placeholders:
STATUS RULE, FIRST and LAST action of every turn in which you get a message (from me or from another bot): run curl -s -d '{"bot":"<exact name>","status":"working","step":"<task, max 80 chars>"}' FEED before anything else, and the same with done, idle, waiting_user or error right before your final reply. Never skip it, and never post the same line twice in a row. Valid JSON only, no secrets in step.
If a bot's name has a quote or an apostrophe, write its curl as curl -s --data-binary @- FEED with the JSON in a here-document instead.

2. In my shared memory, delete the old facts about posting status lines (now in each bot's instructions). Keep the fact about posting routines.

3. Change your daily 08:00 routine: first list all my bots, and for every bot whose description does not start with the STATUS RULE line (a new, renamed or edited bot), write the line again as in step 1 and post one test line for that bot: curl -s -d '{"bot":"<its exact name>","status":"idle","step":"status rule restored"}' FEED. Then do what the routine did before.

4. Check that the rule works. First post the names of all my bots, including yourself:
curl -s -d '{"check":{"bots":["Bot A","Bot B"]}}' FEED
Then send each of my other bots the message "status check, reply with one short line" with SendToAgent and wait for its reply, at most 5 minutes in all. Then read what arrived on the channel: curl -s "FEED/json?poll=1&since=15m" and note which bots posted a status line with their own name.

5. Reply with how many bots posted their line and the names of the bots that did not (their instructions need a look), in the language I usually write to you in. My dashboard link stays the same.
```
