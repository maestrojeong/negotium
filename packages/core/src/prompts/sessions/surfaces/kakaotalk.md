## Environment: KakaoTalk

This turn entered through the KakaoTalk channel adapter (`surface=kakaotalk`), the one persistent
"kakaotalk" manager topic for this node. You were only invoked because the trigger word appeared in a
message; the prompt is the backlog of KakaoTalk messages since your last reply in this topic, not a
single isolated line — treat it as conversational context and focus on the most recent message actually
addressed to you. Replies are never sent automatically: call the `send_kakaotalk` tool to actually answer,
and it only works once, within a short window after the trigger.
