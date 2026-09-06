"""Build an Iron Fist GLB from a skinned Mixamo character and action FBXs.

Run with Blender, not the system Python:
  blender --background --factory-startup --python scripts/build_ironfist_fighter.py -- BODY.fbx OUTPUT.glb
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy


CLIPS = {
    "idle": "Fighting Idle.fbx",
    "attack": "Cross Punch.fbx",
    "defend": "Standing Block Idle.fbx",
    "charge": "Sword And Shield Power Up.fbx",
    "hit": "Head Hit.fbx",
    "dodge": "Dodging.fbx",
    "ko": "Falling Back Death.fbx",
}


def script_args() -> tuple[Path, Path]:
    try:
        separator = sys.argv.index("--")
    except ValueError as exc:
        raise SystemExit("Expected arguments after --: BODY.fbx OUTPUT.glb") from exc
    args = sys.argv[separator + 1 :]
    if len(args) != 2:
        raise SystemExit("Expected exactly two arguments: BODY.fbx OUTPUT.glb")
    return Path(args[0]).resolve(), Path(args[1]).resolve()


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.actions,
        bpy.data.armatures,
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
    ):
        for block in list(collection):
            collection.remove(block)


def import_fbx(path: Path) -> tuple[list[bpy.types.Object], list[bpy.types.Action]]:
    objects_before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    result = bpy.ops.import_scene.fbx(
        filepath=str(path),
        use_anim=True,
        use_image_search=True,
        ignore_leaf_bones=False,
        automatic_bone_orientation=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"FBX import failed: {path}")
    return (
        [obj for obj in bpy.data.objects if obj not in objects_before],
        [action for action in bpy.data.actions if action not in actions_before],
    )


def find_armature(objects: list[bpy.types.Object], source: Path) -> bpy.types.Object:
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]
    if not armatures:
        raise RuntimeError(f"No armature found in {source}")
    return max(armatures, key=lambda obj: len(obj.data.bones))


def action_for_armature(
    armature: bpy.types.Object,
    imported_actions: list[bpy.types.Action],
    source: Path,
) -> bpy.types.Action:
    assigned = getattr(getattr(armature, "animation_data", None), "action", None)
    if assigned in imported_actions:
        return assigned
    if not imported_actions:
        raise RuntimeError(f"No animation action found in {source}")
    return max(imported_actions, key=lambda action: action.frame_range[1] - action.frame_range[0])


def remove_objects(objects: list[bpy.types.Object]) -> None:
    for obj in objects:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def main() -> None:
    body_path, output_path = script_args()
    repo_root = Path(__file__).resolve().parents[1]
    action_dir = repo_root / "docs" / "games"

    if not body_path.is_file():
        raise SystemExit(f"Body FBX does not exist: {body_path}")
    missing = [name for name in CLIPS.values() if not (action_dir / name).is_file()]
    if missing:
        raise SystemExit(f"Missing action FBXs in {action_dir}: {', '.join(missing)}")

    clear_scene()
    body_objects, body_actions = import_fbx(body_path)
    body_armature = find_armature(body_objects, body_path)
    body_armature.name = "Armature"
    body_armature.data.name = "Armature"

    # The body download may contain a T-pose or an arbitrary preview motion. The
    # game uses only the seven canonical actions imported below.
    if body_armature.animation_data:
        body_armature.animation_data_clear()
    for action in body_actions:
        bpy.data.actions.remove(action)

    canonical_actions: dict[str, bpy.types.Action] = {}
    for clip_name, filename in CLIPS.items():
        source = action_dir / filename
        imported_objects, imported_actions = import_fbx(source)
        source_armature = find_armature(imported_objects, source)
        action = action_for_armature(source_armature, imported_actions, source)

        # Remove any stale action with the canonical name before renaming. FBX
        # import otherwise adds Blender suffixes such as `.001`.
        stale = bpy.data.actions.get(clip_name)
        if stale and stale != action:
            bpy.data.actions.remove(stale)
        action.name = clip_name
        action.use_fake_user = True
        canonical_actions[clip_name] = action

        for extra_action in imported_actions:
            if extra_action != action:
                bpy.data.actions.remove(extra_action)
        remove_objects(imported_objects)

    # Blender 5.1 may omit the currently active action in ACTIONS mode. Put every
    # canonical action on its own named NLA track so the exporter emits exactly
    # one glTF animation per game clip, including idle.
    body_armature.animation_data_create()
    body_armature.animation_data.action = None
    for clip_name, action in canonical_actions.items():
        track = body_armature.animation_data.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, int(action.frame_range[0]), action)
        strip.name = clip_name

    bpy.ops.object.select_all(action="DESELECT")
    export_objects = [obj for obj in body_objects if obj.name in bpy.data.objects]
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = body_armature

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_merge_animation="NLA_TRACK",
        export_anim_single_armature=True,
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_reset_pose_bones=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_apply=False,
        check_existing=False,
    )
    if "FINISHED" not in result or not output_path.is_file():
        raise RuntimeError(f"GLB export failed: {output_path}")

    print(f"BODY={body_path}")
    print(f"ARMATURE_BONES={len(body_armature.data.bones)}")
    print(f"MESHES={','.join(obj.name for obj in export_objects if obj.type == 'MESH')}")
    print(f"ANIMATIONS={','.join(canonical_actions)}")
    print(f"OUTPUT={output_path}")
    print(f"OUTPUT_BYTES={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
