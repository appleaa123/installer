#!/bin/bash
# Human task 33 (docs/human-tasks.md): the owner's email brief end to end, Home 1 (TaskFollow's runner on Claude
# Code) and Home 2 (Claude Cowork's own schedule). One short command per step:
#   bash ~/Desktop/ML-Project/installer/docs/testing/task33-steps.sh <step>
# Steps: setup email channel gateway workflow describe once t7 home1 t8 deliver home2 clean
set -u
REPO="$HOME/Desktop/ML-Project/installer"
DIR="$HOME/taskfollow-task33"
TF=(node "$REPO/dist/cli.js" --home "$DIR/home")
COWORK='{"agent":"Claude Cowork"}'
AWAY='{"agent":"Claude Cowork","while_away":true}'
BRIEF='{"description":"Every morning, read my newest emails and give me a short brief: who wrote, what they need, and what needs a visit or a reply. Never send anything.","tools":["channel.inbox"]}'

submit() { echo "== $1"; "${TF[@]}" submit "$1" --value "$2" | tail -c 300; echo; }

case "${1:-}" in
  setup)   (cd "$REPO" && npm run build --silent) || exit 1
           mkdir -p "$DIR" && cd "$DIR" || exit 1
           echo "== settings checksum (before)"; shasum -a 256 "$HOME/.claude/settings.json"
           echo "== start"; "${TF[@]}" start --solution starter | tail -c 300; echo
           submit mode.who '"me"'; submit mode.name '"Owner"'; submit mode.always-on '"no"'
           submit services.records '"none"'; submit services.telegram '"none"'; submit services.email '"email"'
           submit services.slack '"none"'; submit services.whatsapp '"none"' ;;
  email)   cd "$DIR" && "${TF[@]}" secret email ;;
  channel) cd "$DIR" && "${TF[@]}" channel email ;;
  gateway) cd "$DIR" && "${TF[@]}" gateway start ;;
  workflow) cd "$DIR" && "${TF[@]}" workflow add morning-brief --value "$BRIEF" ;;
  describe) cd "$DIR" && "${TF[@]}" check start describe --workflow morning-brief ;;
  once)    cd "$DIR" && "${TF[@]}" check once morning-brief ;;
  t7)      cd "$DIR" && "${TF[@]}" check start t7 --workflow morning-brief ;;
  home1)   cd "$DIR" && "${TF[@]}" check home morning-brief
           echo "== summary"; "${TF[@]}" check summary morning-brief | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).text))'
           echo "== a run by hand"; "${TF[@]}" run morning-brief --sandbox | tail -c 400; echo
           echo "== why"; "${TF[@]}" why ;;
  t8)      cd "$DIR" && "${TF[@]}" check start t8 --workflow morning-brief --value "$COWORK" ;;
  deliver) cd "$DIR" && "${TF[@]}" check deliver morning-brief ;;
  home2)   cd "$DIR" && "${TF[@]}" check summary morning-brief --value "$AWAY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).text))' ;;
  clean)   cd "$DIR" && "${TF[@]}" gateway stop
           claude mcp remove -s user installer
           echo "== settings checksum (after; must equal the one from setup)"; shasum -a 256 "$HOME/.claude/settings.json"
           echo "Never run 'taskfollow uninstall' here: it deletes your real keychain items."
           echo "In Claude: delete the scheduled tasks for this test, and the skills taskfollow-check-… and morning-brief in Settings, then Skills."
           echo "Then: rm -rf $DIR and the folders for it under ~/.claude/projects (ls ~/.claude/projects | grep taskfollow-task33)" ;;
  *)       echo "Usage: bash $0 <step>   (steps: setup email channel gateway workflow describe once t7 home1 t8 deliver home2 clean)"; exit 1 ;;
esac
