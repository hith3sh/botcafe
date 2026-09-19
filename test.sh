#!/bin/sh
# End-to-end smoke test against a deployed botcafe. Usage: ./test.sh [base-url]
set -e
B=${1:-https://botcafe.dev}; J='content-type: application/json'
j() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
fail() { echo "FAIL $1"; exit 1; }
ADM=$( [ -f .admin-key ] && echo "x-admin-key: $(cat .admin-key)" || echo "x-none: 1" )  # admin key skips the per-IP limits
KEY=$(curl -s -X POST $B/register -H "$J" -H "$ADM" -d '{"name":"smoke"}' | j .key); [ -n "$KEY" ] || fail register
O="authorization: Bearer $KEY"
C=$(curl -s -X POST $B/conversations -H "$O" -H "$J" -H "$ADM" -d '{"title":"smoke test"}')
ID=$(echo "$C" | j .id); T1=$(echo "$C" | j '.agents["agent-1"]'); T2=$(echo "$C" | j '.agents["agent-2"]')
U=$B/c/$ID; A1="authorization: Bearer $T1"; A2="authorization: Bearer $T2"
# private by default
curl -s $B/conversations | grep -q "\"$ID\"" && fail "private conv listed"
curl -s -o /dev/null -w '%{http_code}' $U/messages | grep -q 403 || fail "private readable without key"
curl -s $U/llms.txt | grep -q "$U/msg" || fail "llms.txt needs a key"
# owner key cannot post; agent token cannot post as another name; since is required
curl -s -o /dev/null -w '%{http_code}' -X POST $U/msg -H "$O" -H "$J" -d '{"agent":"agent-1","text":"x","since":0}' | grep -q 403 || fail "owner key could post"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/msg -H "$A1" -H "$J" -d '{"agent":"agent-2","text":"x","since":0}' | grep -q 403 || fail "token posted as other name"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/msg -H "$A1" -H "$J" -d '{"text":"x"}' | grep -q 400 || fail "since not required"
# names: agent-1 becomes Nova; agent-2 cannot take Nova; shows in /agents and /info
curl -s -X POST $U/name -H "$A1" -H "$J" -d '{"name":"Nova"}' | grep -q '"name":"Nova"' || fail name
curl -s -o /dev/null -w '%{http_code}' -X POST $U/name -H "$A2" -H "$J" -d '{"name":"Nova"}' | grep -q 409 || fail "duplicate name"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/name -H "$A2" -H "$J" -d '{"name":"x"}' | grep -q 400 || fail "short name"
curl -s $U/info -H "$O" | grep -q '"agent-1":"Nova"' || fail "info names"
# post wakes the waiting other agent
curl -s "$U/wait?since=0" -H "$A2" > /tmp/ab_w & W=$!; sleep 1
curl -s -X POST $U/msg -H "$A1" -H "$J" -d '{"text":"ping","since":0}' | grep -q '"id":1' || fail post
wait $W; grep -q '"agent":"agent-1","text":"ping"' /tmp/ab_w || fail "wait: $(cat /tmp/ab_w)"
# stale since is refused with the missed messages
curl -s -X POST $U/msg -H "$A2" -H "$J" -d '{"text":"late","since":0}' | grep -q '"messages":\[{"id":1' || fail "stale since accepted"
# owes_reply: agent-2 owes, agent-1 does not
curl -s $U/agents -H "$A2" | grep -q '"agent":"agent-2".*"owes_reply":true' || fail "owes_reply"
curl -s $U/agents -H "$A2" | grep -q '"agent":"agent-1".*"name":"Nova"' || fail "agents name"
# reply:false clears the debt
curl -s -X POST $U/msg -H "$A2" -H "$J" -d '{"text":"got it","since":1,"reply":false}' | grep -q '"reply":false' || fail "reply false"
curl -s $U/agents -H "$A1" | grep -q '"agent":"agent-1".*"owes_reply":false' || fail "owes_reply after ack"
# status: kinds, limit, until, expiry flag
curl -s -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"blocked","text":"asking my human","until":"2020-01-01T00:00:00Z"}' | grep -q blocked || fail status
curl -s $U/agents -H "$A1" | grep -q '"expired":true' || fail "until expiry"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/status -H "$A1" -H "$J" -d "{\"text\":\"$(printf 'x%.0s' $(seq 201))\"}" | grep -q 400 || fail "status limit"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"napping"}' | grep -q 400 || fail "status kind"
curl -s -o /dev/null -w '%{http_code}' -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"working","text":"no until"}' | grep -q 400 || fail "working without until accepted"
# progress vs presence: a wait moves "seen" but not "acted"; a status sets acted and set_at
A1ACT=$(curl -s $U/agents -H "$A1" | j '.find(a=>a.agent=="agent-1").acted'); [ -n "$A1ACT" ] && [ "$A1ACT" != null ] || fail "acted missing"
curl -s -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"waiting","text":"x"}' | grep -q '"set_at"' || fail "status set_at"
curl -s "$U/wait?since=99" -H "$A1" -m 2 > /dev/null || true
curl -s $U/agents -H "$A1" | j '.find(a=>a.agent=="agent-1")' | grep -q "acted" || fail "acted after wait"
# opt-in status wake: agent-2 waits with status=1, agent-1 posts a status, agent-2 wakes with it (not a list)
curl -s "$U/wait?since=99&status=1" -H "$A2" > /tmp/ab_s & W=$!; sleep 1
curl -s -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"working","text":"still on it","until":"2099-01-01T00:00:00Z"}' > /dev/null
wait $W; grep -q '"status":{"agent":"agent-1"' /tmp/ab_s || fail "status wake: $(cat /tmp/ab_s)"
grep -q '"messages":\[\]' /tmp/ab_s || fail "status wake shape"
# a plain wait still sleeps through a status and keeps the list shape
curl -s "$U/wait?since=99" -H "$A2" -m 4 > /tmp/ab_p & W=$!; sleep 1
curl -s -X POST $U/status -H "$A1" -H "$J" -d '{"kind":"waiting"}' > /dev/null
wait $W || true  # curl -m 4 times out on purpose: the plain wait must still be sleeping
grep -q 'status' /tmp/ab_p && fail "plain wait woke on a status: $(cat /tmp/ab_p)"
# redact: owner only, mark stays
curl -s -o /dev/null -w '%{http_code}' -X POST $U/redact -H "$A1" -H "$J" -d '{"id":1}' | grep -q 401 || fail "agent could redact"
curl -s -X POST $U/redact -H "$O" -H "$J" -d '{"id":1}' | grep -q '"redacted":true' || fail redact
curl -s $U/messages -H "$A1" | grep -q 'removed by the board owner' || fail "redact mark"
# URL fallback: the same agent token in the address, for a sandbox that cannot POST. llms.txt points the agent here.
curl -s $U/llms.txt | grep -q 'link.txt?key=TOKEN' || fail "llms.txt has no fallback"
FAKE=ag_$(printf '0%.0s' $(seq 48))
curl -s -o /dev/null -w '%{http_code}' $U/go/$FAKE | grep -q 403 || fail "bad token accepted"
curl -s -o /dev/null -w '%{http_code}' $U/link.txt | grep -q 403 || fail "link.txt without token"
G1=$U/go/$T1; G2=$U/go/$T2
curl -s -o /dev/null -D - "$G1?do=read&since=0" | grep -qi 'cache-control: no-store' || fail "link answer is stored"
curl -s "$U/link.txt?key=$T1" | grep -q "$G1?do=msg" || fail "link.txt addresses"
curl -s "$G1?do=read&since=0" | grep -q "\"send\":\"$G1?do=msg" || fail "read gives the next addresses"
curl -s "$G2?do=name&name=Sandy" | grep -q '"name":"Sandy"' || fail "link name"
curl -s "$G1?do=msg&since=2&text=hello%20link" | grep -q '"ok":true' || fail "link msg"
curl -s "$G1?do=msg&since=2&text=hello%20link" | grep -q '"duplicate":true' || fail "link replay posted twice"
curl -s $U/messages -H "$A1" | grep -q '"text":"hello link"' || fail "link msg text"
curl -s -o /dev/null -w '%{http_code}' "$G2?do=msg&since=0&text=stale" | grep -q 409 || fail "link stale since accepted"
curl -s -o /dev/null -w '%{http_code}' "$G1?do=msg&text=nosince" | grep -q 400 || fail "link since not required"
curl -s -o /dev/null -w '%{http_code}' "$G1?do=msg&since=99&text=$(printf 'x%.0s' $(seq 2001))" | grep -q 400 || fail "link text limit"
curl -s -o /dev/null -w '%{http_code}' "$G1?do=status&kind=working&text=x" | grep -q 400 || fail "link working without until"
curl -s "$G1?do=status&kind=blocked&text=asking%20my%20human" | grep -q '"ok":true' || fail "link status"
curl -s "$G1?do=agents" | grep -q '"name":"Sandy"' || fail "link agents"
curl -s -o /dev/null -w '%{http_code}' "$G1?do=jump" | grep -q 400 || fail "unknown link verb"
# share needs a message (this board has 2), then lists; a fresh empty board cannot be shared
E=$(curl -s -X POST $B/conversations -H "$O" -H "$J" -H "$ADM" -d '{"title":"empty"}' | j .id)
curl -s -o /dev/null -w '%{http_code}' -X POST $B/c/$E/visibility -H "$O" -H "$J" -d '{"visibility":"public"}' | grep -q 400 || fail "empty board shared"
curl -s -X POST $B/c/$E/delete -H "$O" | grep -q '"deleted":true' || fail delete
curl -s -o /dev/null -w '%{http_code}' $B/c/$E/info -H "$O" | grep -q 404 || fail "deleted board still there"
curl -s -X POST $U/visibility -H "$O" -H "$J" -d '{"visibility":"public"}' | grep -q public || fail visibility
curl -s $B/conversations | grep -q "\"$ID\"" || fail list
curl -s "$B/conversations?page=1&limit=5" | grep -q '"conversations"' || fail "list page shape"
curl -s "$B/conversations?page=1&limit=5" | grep -q '"pages"' || fail "list pages"
curl -s $U/llms.txt | grep -q "$U/msg" || fail llms
curl -s $U/ | grep -q botcafe || fail "board html"
curl -s -o /dev/null -w '%{content_type}' $B/c/0000000000000000/messages | grep -q json || fail "404 not json"
curl -s -o /dev/null -D - $U/ | grep -qi 'x-robots-tag: noindex' || fail "board indexable"
curl -s $B/robots.txt | grep -q 'Disallow: /admin/' || fail robots
curl -s $B/robots.txt | grep -q 'Disallow: /c/' && fail "robots blocks agents from their own board"
curl -s -o /dev/null -D - $U/llms.txt | grep -qi 'x-robots-tag: noindex' || fail "llms.txt indexable"
curl -s $B/sitemap.xml | grep -q 'botcafe.dev/home' || fail sitemap
curl -s $B/home | grep -qi 'meta name="description"' || fail "home meta"
curl -s $B/home | grep -qi 'rel="canonical"' || fail "home canonical"
curl -s $B/home | grep -q 'how it works' || fail "home copy"
curl -s $B/home | grep -q 'built for agents' && fail "home built-for-agents"
curl -s $B/home | grep -q '/demo.gif' || fail "home gif"
curl -s -o /dev/null -w '%{http_code} %{content_type}' $B/demo.gif | grep -q '200 image/gif' || fail "demo.gif"
curl -s -o /dev/null -w '%{http_code} %{content_type}' $B/demo.mp4 | grep -q '200 video/mp4' || fail "demo.mp4"
curl -s $B/a/openai-agents-hugging-face-message-board | grep -q 'Artifactory' || fail "article openai-hf"
curl -s $B/a/share-context | grep -qi 'share context' || fail "article share-context"
curl -s $B/a/make-two-ai-agents-talk | grep -qi 'make two AI agents talk' || fail "article make-two"
curl -s $B/a/cloud-and-laptop | grep -qi 'laptop' || fail "article cloud"
curl -s $B/a/commercial-and-open | grep -qi 'open-source\|open model\|open-source' || fail "article commercial"
curl -s $B/sitemap.xml | grep -q 'share-context' || fail "sitemap articles"
curl -s $B/sitemap.xml | grep -q 'make-two-ai-agents-talk' || fail "sitemap make-two"
curl -s $B/home | grep -qi 'botcafe.dev' || fail "home brand"
curl -s -o /dev/null -D - $B/home | grep -qi 'x-robots-tag: noindex' && fail "home noindex"
curl -s $B/ | grep -q 'application/ld+json' || fail "json-ld"
curl -s -o /dev/null -w '%{http_code}' $B/admin/stats | grep -q 401 || fail "stats without admin key"
if [ -f .admin-key ]; then
  curl -s $B/admin/stats -H "$ADM" | grep -q '"conversation_list"' || fail "admin stats"
  curl -s -X POST $B/admin/hide -H "authorization: Bearer $(cat .admin-key)" -H "$J" -d "{\"id\":\"$ID\"}" | grep -q hidden || fail "admin hide"
  curl -s -o /dev/null -w '%{http_code}' $U/messages -H "$O" | grep -q 410 || fail "hidden board readable"
fi
echo "OK  $U"
