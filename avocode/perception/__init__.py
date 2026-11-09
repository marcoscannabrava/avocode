"""Grid analysis for prompts."""

from avocode.perception.around import describe_around
from avocode.perception.changes import Change, describe_changes, scene_changes
from avocode.perception.diff import GridDiff, describe_diff, grid_diff
from avocode.perception.encode import background_color, encode_grid
from avocode.perception.layout import Layout
from avocode.perception.objects import Blob, find_blobs
from avocode.perception.scene import Scene, SceneObject, build_scene, describe_scene
from avocode.perception.summary import state_header, summarize_state
from avocode.perception.tracker import Tracker, scene_text

__all__ = [
    "Blob",
    "Change",
    "GridDiff",
    "Layout",
    "Scene",
    "SceneObject",
    "Tracker",
    "background_color",
    "build_scene",
    "describe_around",
    "describe_changes",
    "describe_diff",
    "describe_scene",
    "encode_grid",
    "find_blobs",
    "grid_diff",
    "scene_changes",
    "scene_text",
    "state_header",
    "summarize_state",
]
