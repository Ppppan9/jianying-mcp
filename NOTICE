# NOTICE

## This project

`jianying-mcp` — a MiniMax-native MCP server and Plugin package that generates
JianYing Pro (剪映专业版) draft projects programmatically.

Licensed under the MIT License (see `LICENSE`).

Copyright (c) 2026 Hou Tao (Ppppan9)

---

## Third-party work this project derives from

This project is an independent re-implementation. It was written by reverse
engineering the **JianYing draft file format** and validating the result
against two existing open-source projects, both of which are acknowledged here.

### 1. `jianying-editor-skill`

- Upstream: <https://github.com/luoluoluo22/jianying-editor-skill>
- Copyright (c) 2026 luoluoluo22
- License: MIT
- Used as: the **reference oracle** for draft-format validation. The
  `scripts/compare_drafts.py` and `scripts/gen_upstream_same.py` scripts in
  this repository drive the upstream implementation and diff its output
  against this project's output.

No upstream source code is redistributed in this repository.

### 2. `pyJianYingDraft`

- Upstream: <https://github.com/GuanYixuan/pyJianYingDraft>
- Copyright (c) 2024 GuanYixuan (管奕轩)
- License: Apache License 2.0
- Used as: the **authoritative statement of the JianYing draft JSON schema**.
  Field names, the `materials` bucket set, segment serialization rules and
  timing semantics documented in `docs/DRAFT_FORMAT.md` were derived from
  reading that project's source.

No upstream source code is redistributed in this repository. This project is
an independent TypeScript implementation of the same file format.

---

## Trademarks

JianYing (剪映) and CapCut are trademarks of their respective owners. This
project is an unofficial, independent tool. It is not affiliated with,
endorsed by, or sponsored by ByteDance or any other company mentioned here.

JianYing has no public editing API. This project works by writing draft
project files to the local draft directory, the same mechanism used by many
existing community tools.
