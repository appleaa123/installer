#!/bin/bash
# Human task 29 (docs/superpowers/plans/2026-10-15-skill-loading-spike.md): run one step at a time,
#   bash ~/Desktop/ML-Project/installer/docs/testing/task29-spike.sh <step>
# Steps: 1 1r 1b 2 3 4 5 5b 6 7 8 9 10. Each step changes one thing from the step before it.
set -u
REPO="$HOME/Desktop/ML-Project/installer"
SHOW="$REPO/docs/testing/task29-show.mjs"
DIR="$HOME/taskfollow-task29"
ELSEWHERE="$HOME/taskfollow-task29-elsewhere"
TF_HOME="$DIR/home"
A="${SPIKE_PREFIX:-}What is the TaskFollow check word? Answer with the word only."
B="List the names of the skills you can see, comma-separated, nothing else."
ALLOW_SKILL=(--allowedTools "Skill(taskfollow-spike)")
PRODUCT=(--restricted --permission-prompts none --permission-mode manual --tools "" --allowedTools "mcp__installer__actions_reason" --settings '{}')

ask() {
  local label="$1" prompt="$2"
  shift 2
  echo "== $label"
  claude -p "$prompt" --output-format stream-json --verbose --no-session-persistence "$@" | node "$SHOW"
}

cd "$DIR" || { echo "Run the setup first: $DIR is missing"; exit 1; }
case "${1:-}" in
  1)  ask "1 A" "$A" "${ALLOW_SKILL[@]}"
      ask "1 B" "$B" "${ALLOW_SKILL[@]}" ;;
  1r) ask "1r A, naming the skill" "Use the taskfollow-spike skill. $A" "${ALLOW_SKILL[@]}" ;;
  1b) ask "1b B, without user-level skills" "$B" "${ALLOW_SKILL[@]}" --setting-sources project,local ;;
  2)  ask "2 A" "$A" "${ALLOW_SKILL[@]}" --restricted
      ask "2 B" "$B" "${ALLOW_SKILL[@]}" --restricted ;;
  3)  ask "3 A" "$A" "${ALLOW_SKILL[@]}" --restricted --tools ""
      ask "3 B" "$B" "${ALLOW_SKILL[@]}" --restricted --tools "" ;;
  4)  ask "4 A" "$A" "${PRODUCT[@]}"
      ask "4 B" "$B" "${PRODUCT[@]}" ;;
  5)  ask "5 A" "$A" --restricted --permission-prompts none --permission-mode manual --tools "Skill" --allowedTools "Skill(taskfollow-spike),mcp__installer__actions_reason" --settings '{}' ;;
  5b) ask "5b A, bare Skill rule" "$A" --restricted --permission-prompts none --permission-mode manual --tools "Skill" --allowedTools "Skill,mcp__installer__actions_reason" --settings '{}' ;;
  6)  ask "6 A, /skill prefix" "/taskfollow-spike $A" "${PRODUCT[@]}" ;;
  7)  mkdir -p "$ELSEWHERE" "$DIR/deep/a/b/c"
      cd "$ELSEWHERE" && ask "7a B, unrelated folder" "$B" "${ALLOW_SKILL[@]}" --restricted
      ask "7b A, --add-dir" "$A" "${ALLOW_SKILL[@]}" --restricted --add-dir "$DIR"
      ask "7b B, --add-dir" "$B" "${ALLOW_SKILL[@]}" --restricted --add-dir "$DIR"
      cd "$DIR/deep/a/b/c" && ask "7c B, deep subfolder" "$B" "${ALLOW_SKILL[@]}" --restricted ;;
  8)  USER_SKILL="$HOME/.claude/skills/taskfollow-spike-user"
      mkdir -p "$USER_SKILL"
      printf '%s\n' '---' 'name: taskfollow-spike-user' 'description: Use when asked for the TaskFollow user check word.' '---' 'When asked for the TaskFollow user check word, answer with exactly: HERON-5189' > "$USER_SKILL/SKILL.md"
      ask "8 user-level skill" "What is the TaskFollow user check word? Answer with the word only." "${PRODUCT[@]}"
      rm -r "$USER_SKILL"
      ls "$HOME/.claude/skills" | grep taskfollow-spike-user || echo "user skill removed" ;;
  9)  (cd "$REPO" && npm run build --silent) || exit 1
      CLI=(node "$REPO/dist/cli.js" --home "$TF_HOME")
      echo "== 9 start"; "${CLI[@]}" start --solution starter
      echo "== 9 workflow add"
      "${CLI[@]}" workflow add spike --value '{"description":"spike: does the agent load a skill in a task run","trigger":{"manual":true},"steps":[{"id":"word","task":{"prompt":"What is the TaskFollow check word? If you can see a skill about it, use it. Answer with the word only.","input":{},"may_use":["mcp__none"],"output":{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}}}]}'
      echo "== 9 run"
      OUT="$("${CLI[@]}" run spike --sandbox)"; echo "$OUT"
      RUN_ID="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).run_id??"")}catch{console.log("")}})')"
      [ -n "$RUN_ID" ] || { echo "No run id found in the run output above"; exit 1; }
      echo "== 9 why $RUN_ID"; "${CLI[@]}" why "$RUN_ID"
      echo "== 9 word.json"; cat "$TF_HOME/runs/spike/$RUN_ID/steps/word.json"; echo
      echo "== 9 word.calls.jsonl"; cat "$TF_HOME/runs/spike/$RUN_ID/word.calls.jsonl" 2>/dev/null || echo "(no calls recorded)" ;;
  10) echo "== 10 (never taskfollow uninstall here: it deletes your real keychain items)"
      claude mcp remove -s user installer
      echo "== mcp list (takes a few seconds)"; claude mcp list
      echo "== settings.json checksum"; shasum -a 256 "$HOME/.claude/settings.json"
      echo "== transcripts before removal"; ls "$HOME/.claude/projects" | grep taskfollow-task29 || echo "none"
      ls "$HOME/.claude/skills" | grep taskfollow-spike || echo "no spike skill left"
      cd "$HOME"
      rm -rf "$HOME"/.claude/projects/*taskfollow-task29* "$DIR" "$ELSEWHERE"
      ls "$HOME/.claude/projects" | grep taskfollow-task29 || echo "transcripts removed" ;;
  *)  echo "Usage: bash $0 <step>   (steps: 1 1r 1b 2 3 4 5 5b 6 7 8 9 10)"; exit 1 ;;
esac
