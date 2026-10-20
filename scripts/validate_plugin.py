#!/usr/bin/env python3
"""
Validates a local MiniMax Plugin package against the V1 contract.

Checks: manifest shape, referenced files, Skill frontmatter, path portability,
package limits (entry count, file count, per-file and total size, path shape),
icon integrity, and MCP transport rules.
"""

import json
import os
import re
import sys
from pathlib import Path

OK, BAD = "✓", "✗"
errors: list[str] = []
warnings: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  {OK} {label}")
    else:
        print(f"  {BAD} {label}" + (f" — {detail}" if detail else ""))
        errors.append(label)


def warn(label: str, detail: str = "") -> None:
    print(f"  ! {label}" + (f" — {detail}" if detail else ""))
    warnings.append(label)


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    print(f"\nValidating plugin package: {root}\n")

    # --- manifest ---------------------------------------------------------
    print("[1] Manifest")
    manifest_path = root / ".minimax-plugin" / "plugin.json"
    check("manifest exists", manifest_path.exists(), str(manifest_path))
    if not manifest_path.exists():
        print("\nCannot continue without a manifest.")
        return 1

    raw = manifest_path.read_bytes()
    check("manifest has no BOM", not raw.startswith(b"\xef\xbb\xbf"))
    check("manifest is valid UTF-8", _is_utf8(raw))
    manifest = json.loads(raw.decode("utf-8"))

    required = [
        "schemaVersion", "name", "version", "description", "author",
        "icon", "category", "exampleQueries", "apps", "mcpServers", "skills",
    ]
    for field in required:
        check(f"manifest has '{field}'", field in manifest)

    check("schemaVersion is 1", manifest.get("schemaVersion") == 1)
    name = manifest.get("name", "")
    check(
        "name matches the required pattern",
        bool(re.match(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", name)),
        name,
    )
    # The manifest name must equal the directory name when the package sits at
    # the Plugin root. A package checked out under a different folder name
    # (for example a repo's `plugin/` subdirectory) is still valid, so this is
    # reported as a warning rather than an error.
    if name == root.name:
        print(f"  {OK} name matches the directory name")
    else:
        warn(
            "name differs from the directory name",
            f"manifest '{name}' vs directory '{root.name}' — rename the folder before installing",
        )
    version = manifest.get("version", "")
    check(
        "version is SemVer",
        bool(re.match(r"^\d+\.\d+\.\d+(?:[-+].*)?$", version)),
        version,
    )

    categories = {
        "Office", "Studio", "Design & Sites", "Code", "Business", "Sales",
        "Productivity", "Science & Healthcare", "Education", "Other",
    }
    check("category is valid", manifest.get("category") in categories, manifest.get("category"))

    queries = manifest.get("exampleQueries", [])
    check("exampleQueries is a non-empty list", isinstance(queries, list) and len(queries) > 0)
    check("every example query has content", all(isinstance(q, str) and q.strip() for q in queries))

    check("apps is an empty array", manifest.get("apps") == [])

    at_least_one = (
        manifest.get("mcpServers")
        or manifest.get("skills")
        or manifest.get("agents")
        or manifest.get("hooks")
    )
    check("at least one effective capability", bool(at_least_one))

    # --- icons ------------------------------------------------------------
    print("\n[2] Icons")
    icon = manifest.get("icon")
    check("icon file exists", (root / icon).exists() if icon else False, str(icon))
    if icon:
        ext = Path(icon).suffix.lower()
        check("icon extension is valid", ext in {".png", ".jpg", ".jpeg", ".webp"}, ext)
        raw_icon = (root / icon).read_bytes()
        check("icon bytes match its extension", _icon_matches(raw_icon, ext))
    dark = manifest.get("darkIcon")
    if dark:
        check("darkIcon file exists", (root / dark).exists(), str(dark))
        dext = Path(dark).suffix.lower()
        check("darkIcon extension is valid", dext in {".png", ".jpg", ".jpeg", ".webp"}, dext)
        check("darkIcon bytes match its extension", _icon_matches((root / dark).read_bytes(), dext))
        check("icon and darkIcon are different files", icon != dark)
    else:
        warn("no darkIcon declared (optional)")

    # --- capabilities -----------------------------------------------------
    print("\n[3] MCP servers")
    for rel in manifest.get("mcpServers", []):
        path = root / rel
        check(f"mcp file exists: {rel}", path.exists())
        if not path.exists():
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        check(f"{rel} has schemaVersion 1", doc.get("schemaVersion") == 1)
        servers = doc.get("mcpServers", {})
        check(f"{rel} has a non-empty mcpServers object", bool(servers))
        for sname, cfg in servers.items():
            check(
                f"server '{sname}' name is valid",
                bool(re.match(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", sname)),
                sname,
            )
            transport = cfg.get("type")
            check(f"server '{sname}' uses a supported transport",
                  transport in {"stdio", "streamable-http", "sse"}, str(transport))
            for banned in ("auth", "oauth", "refresh", "http"):
                check(f"server '{sname}' has no '{banned}' field", banned not in cfg)
            if transport == "stdio":
                cmd = cfg.get("command", "")
                check(f"server '{sname}' command has no slash", "/" not in cmd and "\\" not in cmd, cmd)
                for arg in cfg.get("args", []):
                    check(f"server '{sname}' arg is relative: {arg}",
                          not arg.startswith("/") and ".." not in arg)
                    resolved = (root / arg).resolve()
                    check(f"server '{sname}' arg resolves inside the package: {arg}",
                          str(resolved).startswith(str(root)), str(resolved))
            timeout = cfg.get("timeout")
            if timeout is not None:
                check(f"server '{sname}' timeout is a positive integer",
                      isinstance(timeout, int) and timeout > 0, str(timeout))

    print("\n[4] Skills")
    for rel in manifest.get("skills", []):
        path = root / rel
        check(f"skill file exists: {rel}", path.exists())
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        check(f"{rel} starts with YAML frontmatter", text.startswith("---\n"))
        fm = _frontmatter(text)
        check(f"{rel} frontmatter has a name", "name" in fm, str(fm.get("name")))
        check(f"{rel} frontmatter has a description", bool(fm.get("description", "").strip()))
        check(f"{rel} name matches the directory",
              fm.get("name") == Path(rel).parent.name,
              f"{fm.get('name')} vs {Path(rel).parent.name}")

    print("\n[5] Subagents & hooks")
    check("no subagents declared", manifest.get("agents", []) == [])
    check("no hooks declared", manifest.get("hooks", []) == [])

    # --- package limits ---------------------------------------------------
    print("\n[6] Package limits")
    entries = list(root.rglob("*"))
    files = [p for p in entries if p.is_file()]
    dirs = [p for p in entries if p.is_dir()]
    check("at most 2048 total entries", len(entries) <= 2048, str(len(entries)))
    check("at most 1024 regular files", len(files) <= 1024, str(len(files)))

    largest = max((p.stat().st_size for p in files), default=0)
    check("no file exceeds 16 MiB", largest <= 16 * 1024 * 1024, f"{largest} bytes")
    total = sum(p.stat().st_size for p in files)
    check("total size under 64 MiB", total <= 64 * 1024 * 1024, f"{total} bytes")

    bad_paths = []
    for p in files + dirs:
        rel = p.relative_to(root)
        if len(str(rel).encode()) > 512:
            bad_paths.append(f"{rel} (>512 bytes)")
            continue
        for seg in rel.parts:
            if not re.match(r"^[A-Za-z0-9._-]+$", seg):
                bad_paths.append(f"{rel} (segment '{seg}')")
            if seg in (".", ".."):
                bad_paths.append(f"{rel} (dot segment)")
            if seg.endswith("."):
                bad_paths.append(f"{rel} (segment ends with '.')")
            if len(seg.encode()) > 128:
                bad_paths.append(f"{rel} (segment >128 bytes)")
        if len(rel.parts) > 16:
            bad_paths.append(f"{rel} (>16 segments)")
    check("all paths are portable", not bad_paths, "; ".join(bad_paths[:5]))

    special = [str(p.relative_to(root)) for p in entries if p.is_symlink() or (p.exists() and not p.is_file() and not p.is_dir())]
    check("no symlinks or special files", not special, "; ".join(special[:5]))

    # case-insensitive collision check
    lowered: dict[str, str] = {}
    collisions = []
    for p in entries:
        rel = str(p.relative_to(root)).lower()
        if rel in lowered and lowered[rel] != str(p.relative_to(root)):
            collisions.append(rel)
        lowered[rel] = str(p.relative_to(root))
    check("no case-insensitive path collisions", not collisions, "; ".join(collisions[:5]))

    print("\n" + "=" * 60)
    if errors:
        print(f"FAILED — {len(errors)} error(s)")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"PASS — plugin package is valid" + (f" ({len(warnings)} warning(s))" if warnings else ""))
    return 0


def _is_utf8(raw: bytes) -> bool:
    try:
        raw.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _icon_matches(raw: bytes, ext: str) -> bool:
    if ext == ".png":
        return raw[:8] == b"\x89PNG\r\n\x1a\n"
    if ext in (".jpg", ".jpeg"):
        return raw[:2] == b"\xff\xd8" and raw[-2:] == b"\xff\xd9"
    if ext == ".webp":
        return raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return False


def _frontmatter(text: str) -> dict:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[4:end]
    out = {}
    for line in block.splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


if __name__ == "__main__":
    sys.exit(main())
