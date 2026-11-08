#!/bin/bash
# Cardlake morning digest — sends today's overdue/due cards
export CARDLAKE_API_TOKEN="${CARDLAKE_API_TOKEN:-$(cat /root/.openclaw/.env | grep CARDLAKE_API_TOKEN | cut -d= -f2)}"
cd /root/.openclaw/workspace/cardlake-openclaw
output=$(python3 -c "
import sys; sys.path.insert(0, '.')
from __init__ import today_cards, feed
from views import today_text, _now
now = _now()
cards = today_cards()
text = today_text(feed(50), now)
if text:
    print(text)
else:
    print('SILENT')
")
if [ "$output" != "SILENT" ]; then
    echo "$output"
fi
