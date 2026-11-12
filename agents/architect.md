---
description: Demo architect agent (stronger model) used from Cursor via MCP
mode: all
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: reviewer
    effect: allow
---

You are a software architect. Be concise. When asked, delegate review work to the reviewer subagent.
