# Render `claude --print --output-format stream-json --verbose` as readable terminal output.
#
#   jq -R --unbuffered -r --argjson color true -f ralph-render.jq
#
# `color` must be a JSON boolean: jq treats 0 as truthy, so `--argjson color 0` still colours.
#
# Input is read raw (-R) so that non-JSON lines — CLI warnings that arrive on
# stderr — pass through dimmed instead of aborting the whole pipeline.

def sgr($code): if $color then "\u001b[" + $code + "m" else "" end;
def off:    sgr("0");
def dim:    sgr("2");
def red:    sgr("31");
def green:  sgr("32");
def yellow: sgr("33");
def cyan:   sgr("36");

def clip($n): (. // "") | tostring | if (length > $n) then (.[:$n] + "…") else . end;
def flat($n): (. // "") | tostring | gsub("\\s+"; " ") | clip($n);
def indent($p): split("\n") | map($p + .) | join("\n");

# The most useful part of a tool call is what it is acting on.
def target:
  .name as $n | (.input // {}) as $i
  | if   $n == "Bash"                              then ($i.command    | flat(120))
    elif $n == "Read" or $n == "Write"
      or $n == "Edit" or $n == "NotebookEdit"       then ($i.file_path  | flat(120))
    elif $n == "Grep" or $n == "Glob"              then (($i.pattern // "") + " " + ($i.path // "") | flat(120))
    elif $n == "Task" or $n == "Agent"             then ($i.description | flat(120))
    elif $n == "WebFetch" or $n == "WebSearch"     then (($i.url // $i.query) | flat(120))
    elif $n == "Skill"                             then ($i.skill      | flat(120))
    elif $n == "TodoWrite"                         then ""
    else ($i | flat(120)) end;

def render:
  if .type == "system" and .subtype == "init" then
    dim + "· session " + (.session_id // "?" | .[0:8]) + " · " + (.model // "?")
        + " · permissions: " + (.permissionMode // "?") + off

  elif .type == "system" and .subtype == "api_retry" then
    yellow + "! api retry " + (.attempt | tostring) + "/" + (.max_retries | tostring)
           + " — " + ((.error_status // "?") | tostring) + " " + (.error // "") + off

  elif .type == "system" and .subtype == "compact_boundary" then
    dim + "· context compacted" + off

  elif .type == "assistant" then
    [ .message.content[]?
      | if .type == "text" and ((.text // "") | gsub("\\s"; "") | length) > 0 then
          (.text | clip(1000) | indent("  "))
        elif .type == "thinking" then
          dim + "  · thinking…" + off
        elif .type == "tool_use" then
          cyan + "  → " + .name + off + " " + dim + target + off
        else empty end
    ] | join("\n")

  elif .type == "user" then
    # Successful tool results are noise; failures are the signal.
    [ .message.content[]? | select(.type == "tool_result" and (.is_error // false))
      | red + "  ✗ " + ((if (.content | type) == "array" then (.content | map(.text? // "") | join(" ")) else .content end) | flat(300)) + off
    ] | join("\n")

  elif .type == "result" then
    (if (.is_error // false) or (.subtype != "success") then red + "✗ " else green + "✓ " end)
    + (.subtype // "result") + off + dim
    + "  " + ((.num_turns // 0) | tostring) + " turns"
    + "  " + (((.duration_ms // 0) / 1000) | floor | tostring) + "s"
    + (if .total_cost_usd then "  $" + (.total_cost_usd * 10000 | round / 10000 | tostring) else "" end)
    + off

  else empty end;

. as $line
| (try ($line | fromjson) catch null) as $event
| if ($event | type) != "object"
  then (if ($line | gsub("\\s"; "") | length) > 0 then dim + "  " + $line + off else empty end)
  else ($event | render)
  end
| select(. != "")
