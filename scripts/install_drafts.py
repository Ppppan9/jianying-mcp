#!/usr/bin/env python3
"""
Installs the verification drafts into JianYing's draft directory.

Copying the draft folder is not enough. JianYing reads its project list
from `root_meta_info.json` in the drafts root, and a draft that is not in
that registry does not show up — the folder is just ignored.

So this script does four things per draft:

  1. copies the folder,
  2. rewrites the material paths, which point at where the draft was
     built, so they point at the copy,
  3. registers the draft in `root_meta_info.json`,
  4. writes the same id and paths into `draft_meta_info.json`, so the two
     files agree about which draft this is.

Usage:
    python3 install_drafts.py [--apply] [--root <draftsRoot>]

Without --apply it only reports what it would do.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent


def default_drafts_dir() -> Path:
    """
    Where the drafts to install are.

    The verification pack keeps a copy of this script next to its own drafts
    folder, and that copy is the one to run there. In the repository the
    pack lives beside it.
    """
    for candidate in (
        HERE / "草稿",
        HERE.parent / "jianying-verify" / "草稿",
        HERE.parent.parent / "jianying-verify" / "草稿",
    ):
        if candidate.is_dir():
            return candidate
    return HERE / "草稿"


DRAFTS = default_drafts_dir()

# The known macOS draft locations, most specific first. The modern
# international build keeps its drafts inside a sandbox container; the
# domestic build and older releases use ~/Movies.
CANDIDATES = [
    "~/Library/Containers/com.lemon.jianyingpro/Data/Library/Application Support/"
    "JianyingPro/User Data/Projects/com.lveditor.draft",
    "~/Library/Containers/com.lemon.lvpro/Data/Library/Application Support/"
    "JianyingPro/User Data/Projects/com.lveditor.draft",
    "~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft",
    "~/Movies/JianyingPro Drafts",
]


def find_root() -> Optional[Path]:
    for candidate in CANDIDATES:
        path = Path(os.path.expanduser(candidate))
        if path.is_dir():
            return path
    return None


def registry_entry(
    root: Path,
    draft_dir: Path,
    draft_name: str,
    draft_id: str,
    duration_us: int,
) -> dict:
    """An entry in the shape JianYing itself writes."""
    now = int(time.time() * 1_000_000)
    return {
        "cloud_draft_cover": False,
        "cloud_draft_sync": False,
        "draft_cloud_last_action_download": False,
        "draft_cloud_purchase_info": "",
        "draft_cloud_template_id": "",
        "draft_cloud_tutorial_info": "",
        "draft_cloud_videocut_purchase_info": "",
        "draft_cover": str(draft_dir / "draft_cover.jpg"),
        "draft_fold_path": str(draft_dir),
        "draft_id": draft_id,
        "draft_is_ai_shorts": False,
        "draft_is_cloud_temp_draft": False,
        "draft_is_infinite_canvas_draft": False,
        "draft_is_invisible": False,
        "draft_is_pippit_draft": False,
        "draft_is_web_article_video": False,
        "draft_json_file": str(draft_dir / "draft_info.json"),
        "draft_name": draft_name,
        "draft_new_version": "",
        "draft_root_path": str(root),
        # The size of the timeline file in bytes. The application writes it
        # and reads it back, so it has to be the real size.
        "draft_timeline_materials_size": 0,
        "draft_type": "",
        "draft_web_article_video_enter_from": "",
        "pippit_avatar_url": "",
        "pippit_extra_info": "",
        "pippit_id": "",
        "pippit_user_name": "",
        "streaming_edit_draft_ready": True,
        "tm_draft_cloud_completed": "",
        "tm_draft_cloud_entry_id": -1,
        "tm_draft_cloud_modified": 0,
        "tm_draft_cloud_parent_entry_id": -1,
        "tm_draft_cloud_space_id": -1,
        "tm_draft_cloud_user_id": -1,
        "tm_draft_create": now,
        "tm_draft_modified": now,
        "tm_draft_removed": 0,
        "tm_duration": duration_us,
    }


def rewrite_material_paths(info_path: Path) -> int:
    """Points the material paths at the copy."""
    info = json.loads(info_path.read_text(encoding="utf-8"))
    changed = 0
    for material in (info.get("materials") or {}).values():
        if not isinstance(material, list):
            continue
        for entry in material:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            if not isinstance(path, str) or not path:
                continue
            name = entry.get("name") or Path(path).name
            new_path = str(info_path.parent / "materials" / name)
            if path != new_path:
                entry["path"] = new_path
                changed += 1
    if changed:
        info_path.write_text(
            json.dumps(info, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
        )
    return changed


def rewrite_meta(info_path: Path, root: Path, draft_dir: Path, draft_id: str) -> None:
    """Makes the draft's own registry entry agree with the root one."""
    meta_path = draft_dir / "draft_meta_info.json"
    if not meta_path.exists():
        return
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["draft_id"] = draft_id
    meta["draft_name"] = draft_dir.name
    meta["draft_fold_path"] = str(draft_dir)
    meta["draft_root_path"] = str(root)
    meta["draft_cover"] = str(draft_dir / "draft_cover.jpg")
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
    )


def jianying_running() -> Optional[str]:
    """The JianYing process, if it is running."""
    for name in ("VideoFusion-macOS", "JianyingPro", "CapCut"):
        try:
            out = subprocess.run(
                ["/usr/bin/pgrep", "-x", name],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except Exception:
            return None
        if out.returncode == 0 and out.stdout.strip():
            return name
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="actually write")
    parser.add_argument("--root", default="", help="override the drafts root")
    args = parser.parse_args()

    if not DRAFTS.is_dir():
        print(f"找不到草稿目录: {DRAFTS}", file=sys.stderr)
        return 2

    root = Path(os.path.expanduser(args.root)).resolve() if args.root else find_root()
    if root is None:
        print("本机没有找到剪映的草稿目录。剪映可能没装，或草稿位置改过。", file=sys.stderr)
        print("\n已知的 macOS 草稿位置（按优先级）：", file=sys.stderr)
        for candidate in CANDIDATES:
            print(f"  - {os.path.expanduser(candidate)}", file=sys.stderr)
        return 2

    print(f"剪映草稿目录: {root}")

    # The application reads its project list once, when it starts, and it
    # rewrites the registry while it runs. A draft installed into a running
    # application is therefore never seen, and the registry it is written to
    # can be overwritten before the application is restarted.
    running = jianying_running()
    if running:
        print()
        print(f"⚠️  剪映正在运行（{running}）。")
        print("   它的工程列表是启动时读的那一份，现在装进去的草稿它看不见；")
        print("   它还会改写登记册，把你的条目覆盖掉。")
        print("   装完必须**完全退出剪映（⌘Q）再重新打开**才能看到。")

    drafts = sorted(d for d in DRAFTS.iterdir() if d.is_dir())
    if not drafts:
        print(f"{DRAFTS} 里没有草稿", file=sys.stderr)
        return 2

    registry_path = root / "root_meta_info.json"
    registry = (
        json.loads(registry_path.read_text(encoding="utf-8"))
        if registry_path.exists()
        else {"all_draft_store": [], "draft_ids": 0, "root_path": str(root)}
    )
    store = registry.get("all_draft_store") or []

    for draft in drafts:
        name = draft.name
        target = root / name
        exists = target.exists()
        print(f"  {'已存在（会覆盖）' if exists else '将安装'}: {name}")

    print()
    if not args.apply:
        print("以上是计划。确认无误后运行:")
        print(f"  python3 {Path(__file__).name} --apply")
        return 0

    for draft in drafts:
        name = draft.name
        target = root / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(draft, target)

        info_path = target / "draft_info.json"
        rewritten = rewrite_material_paths(info_path)

        # The draft already carries its own identity. The registry has to
        # use that same one — the application keys its project cache by it,
        # and a draft whose three files disagree about its id is a draft the
        # application cannot place.
        info = json.loads(info_path.read_text(encoding="utf-8"))
        draft_id = str(info.get("id") or "").upper()
        if not draft_id:
            draft_id = str(uuid.uuid4()).upper()
            info["id"] = draft_id
            info_path.write_text(
                json.dumps(info, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
            )
        duration = int(info.get("duration") or 0)
        rewrite_meta(info_path, root, target, draft_id)

        entry = registry_entry(root, target, name, draft_id, duration)
        entry["draft_timeline_materials_size"] = info_path.stat().st_size
        # A draft that is already registered is replaced, not duplicated.
        store = [e for e in store if e.get("draft_name") != name]
        store.append(entry)

        print(f"  已安装: {name}（重写 {rewritten} 个素材路径，id {draft_id}）")

    registry["all_draft_store"] = store
    registry["draft_ids"] = len(store)
    registry["root_path"] = str(root)
    registry_path.write_text(
        json.dumps(registry, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
    )
    print(f"\n已登记 {len(store)} 个草稿到 {registry_path}")
    print("重启剪映（或退到首页再进），在工程列表里应该能看到上面的草稿。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
