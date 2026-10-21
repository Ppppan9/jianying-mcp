#!/usr/bin/env python3
"""
Generates a seeded draft for the load → save round-trip check.

The seed carries the material this engine does not model — the kind a real
project contains: effects, stickers, transitions, a canvas, a mask, a keyframe
graph, and a media bin holding a clip that is not on the timeline. Saving the
draft after loading it must not strip any of it.
"""

import json
import os
import sys


def build() -> dict:
    return {
        "business_info": None,
        "canvas_config": {"height": 1080, "ratio": "original", "width": 1920},
        "color_space": 0,
        "complement_frame_config": {
            "open_close_key_complement_frame_flag": False,
            "quality_enhance": False,
        },
        "config": {
            "adjust_max_index": 1,
            "attachment_info": [],
            "combination_max_index": 1,
            "export_range": None,
            "extract_audio_last_index": 1,
            "lyrics_recognition_id": "",
            "lyrics_sync": True,
            "lyrics_taskinfo": [],
            "maintrack_adsorb": True,
            "material_save_mode": 0,
            "multi_language_current": "none",
            "multi_language_list": [],
            "multi_language_main": "none",
            "multi_language_mode": "none",
            "original_sound_last_index": 1,
            "record_audio_last_index": 1,
            "sticker_max_index": 1,
            "subtitle_keywords_config": None,
            "subtitle_recognition_id": "",
            "subtitle_sync": True,
            "subtitle_taskinfo": [],
            "system_font_list": [],
            "video_mute": False,
            "zoom_info_params": None,
            # A key this engine does not model. A newer JianYing might add
            # one, and it has to survive a load and save.
            "future_config_setting": {"on": True},
        },
        "cover": None,
        "create_time": 1700000000000,
        "duration": 4000000,
        "extra_info": None,
        # Likewise at the top level.
        "future_top_level_key": "keep me",
        "fps": 30,
        "free_render_index_mode_on": False,
        "group_container": None,
        "id": "91E08AC5-22FB-47e2-9AA0-7DC300FAEA2B",
        "keyframe_graph_list": [],
        "keyframes": {
            "adjusts": [],
            "audios": [],
            "effects": [],
            "filters": [],
            "handwrites": [],
            "stickers": [],
            "texts": [],
            "videos": [],
        },
        "last_modified_platform": {
            "app_id": 3704,
            "app_source": "lv",
            "app_version": "5.9.0",
            "os": "mac",
        },
        "materials": {
            # Buckets this engine does not model. They must survive a round trip.
            "canvases": [
                {
                    "background": None,
                    "id": "canvas-seed-0001",
                    "type": "canvas_color",
                }
            ],
            "chromas": [],
            "effects": [
                {
                    "id": "effect-seed-0001",
                    "name": "Seed Effect",
                    "resource_id": "res-effect-0001",
                    "type": "video_effect",
                }
            ],
            "filters": [
                {
                    "id": "filter-seed-0001",
                    "name": "Seed Filter",
                    "resource_id": "res-filter-0001",
                    "type": "filter",
                }
            ],
            "masks": [
                {
                    "id": "mask-seed-0001",
                    "name": "Seed Mask",
                    "type": "mask",
                }
            ],
            "material_animations": [
                {
                    "id": "anim-seed-0001",
                    "type": "sticker_animation",
                }
            ],
            "stickers": [
                {
                    "id": "sticker-seed-0001",
                    "name": "Seed Sticker",
                    "resource_id": "res-sticker-0001",
                    "type": "sticker",
                }
            ],
            "transitions": [
                {
                    "id": "transition-seed-0001",
                    "name": "Seed Transition",
                    "resource_id": "res-transition-0001",
                    "type": "transition",
                }
            ],
            "video_effects": [
                {
                    "id": "veffect-seed-0001",
                    "name": "Seed Video Effect",
                    "resource_id": "res-veffect-0001",
                    "type": "video_effect",
                }
            ],
            # Buckets this engine does model.
            "audio_fades": [],
            "audios": [],
            # A photo in the `images` bucket. A loaded draft must keep it
            # there — re-bucketing it would change the user's file.
            "images": [
                {
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 63487,
                    "duration": 10800000000,
                    "height": 600,
                    "id": "image-seed-0001",
                    "local_material_id": "image-seed",
                    "material_id": "image-seed-0001",
                    "material_name": "image_seed.png",
                    "path": "/tmp/jy-roundtrip/Seeded/materials/image_seed.png",
                    "type": "photo",
                    "width": 800,
                }
            ],
            "speeds": [],
            "texts": [],
            "videos": [
                # A clip that is on the timeline.
                {
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 63487,
                    "duration": 4000000,
                    "height": 360,
                    "id": "video-on-timeline",
                    "local_material_id": "on-timeline",
                    "material_id": "video-on-timeline",
                    "material_name": "on_timeline.mp4",
                    "path": "/tmp/jy-roundtrip/Seeded/materials/on_timeline.mp4",
                    "type": "video",
                    "width": 640,
                },
                # A clip in the media bin that no segment references. A real
                # project keeps these, and they must not be swept away.
                {
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 63487,
                    "duration": 3000000,
                    "height": 360,
                    "id": "video-unused",
                    "local_material_id": "unused",
                    "material_id": "video-unused",
                    "material_name": "unused_clip.mp4",
                    "path": "/tmp/jy-roundtrip/Seeded/materials/unused_clip.mp4",
                    "type": "video",
                    "width": 640,
                },
            ],
        },
        "mutable_config": None,
        "name": "",
        "new_version": "110.0.0",
        "platform": {
            "app_id": 3704,
            "app_source": "lv",
            "app_version": "5.9.0",
            "os": "mac",
        },
        "relationships": [],
        "render_index_track_mode_on": True,
        "retouch_cover": None,
        "source": "default",
        "static_cover_image_path": "",
        "time_marks": None,
        "tracks": [
            {
                "attribute": 0,
                "flag": 0,
                "id": "track-seed-0001",
                "is_default_name": False,
                "name": "VideoTrack",
                "segments": [
                    {
                        "clip": {
                            "alpha": 1.0,
                            "flip": {"horizontal": False, "vertical": False},
                            "rotation": 0.0,
                            "scale": {"x": 1.0, "y": 1.0},
                            "transform": {"x": 0.0, "y": 0.0},
                        },
                        "enable_adjust": True,
                        "enable_color_correct_adjust": False,
                        "enable_color_curves": True,
                        "enable_color_match_adjust": False,
                        "enable_color_wheels": True,
                        "enable_lut": True,
                        "enable_smart_color_adjust": False,
                        "extra_material_refs": [
                            "effect-seed-0001",
                            "transition-seed-0001",
                        ],
                        "hdr_settings": {
                            "intensity": 1.0,
                            "mode": 1,
                            "nits": 1000,
                        },
                        "id": "segment-seed-0001",
                        "is_tone_modify": False,
                        "last_nonzero_volume": 1.0,
                        "material_id": "video-on-timeline",
                        "render_index": 0,
                        "reverse": False,
                        "source_timerange": {"duration": 4000000, "start": 0},
                        "speed": 1.0,
                        "target_timerange": {"duration": 4000000, "start": 0},
                        "track_attribute": 0,
                        "track_render_index": 0,
                        "uniform_scale": {"on": True, "value": 1.0},
                        "visible": True,
                        "volume": 1.0,
                    }
                ],
                "type": "video",
            }
        ],
        "update_time": 1700000000000,
        "version": 360000,
        "video_algorithm": {
            "algorithms": [],
            "complement_frame_config": None,
            "deflicker": None,
            "quality_enhance": None,
        },
    }


def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else "seed"
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "draft_info.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(build(), f, ensure_ascii=False, indent=4)
    print(f"seed written: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
