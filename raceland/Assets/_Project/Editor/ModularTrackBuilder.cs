using System.Collections.Generic;
using Raceland.Track;
using Raceland.Vehicle;
using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Lays a closed circuit out of Atomic Realm modular road tiles on their native
    /// 12 m grid, then places the race furniture (start line, checkpoints, boost pads)
    /// against the resulting racing line.
    ///
    /// The grey-box track this replaces is a parametric curve with arbitrary segment
    /// lengths — fine for boxes, useless for a modular kit, because tiles only line up
    /// if every piece sits on the grid at a multiple of 90 degrees. So this builder
    /// walks a rectangular loop cell by cell instead: N straights, a corner, M straights,
    /// a corner, and so on. A rectangle is not the most interesting layout, but it is
    /// guaranteed to close, which a hand-placed loop very often isn't.
    ///
    /// The walk records the centre and heading of every tile, so checkpoints, respawn
    /// anchors and pads are positioned from the real racing line rather than guessed.
    /// </summary>
    public class ModularTrackBuilder : EditorWindow
    {
        [SerializeField] private GameObject straightTile;
        [SerializeField] private GameObject cornerTile;

        [SerializeField] private int longSide = 8;
        [SerializeField] private int shortSide = 5;

        [Tooltip("Rotation added to every corner tile. The kit's corner connects two " +
                 "specific edges, and which two depends on how it was authored — if the " +
                 "corners face the wrong way, step this by 90 until they line up.")]
        [SerializeField] private int cornerYawOffset;

        [SerializeField] private bool clockwise = true;
        [SerializeField] private bool buildFurniture = true;
        [SerializeField] private bool removeExistingTrack = true;

        private const float Grid = ModularRoadPostprocessor.GridSize;

        // The tile is 12 m across but the drivable surface is narrower once kerbs are
        // taken off. Triggers are sized against the drivable part.
        private const float DrivableWidth = 10f;

        [MenuItem("Raceland/Build Track From Modular Road Kit", priority = 43)]
        public static void ShowWindow()
        {
            var w = GetWindow<ModularTrackBuilder>(true, "Modular Track Builder");
            w.minSize = new Vector2(420f, 380f);
        }

        private void OnGUI()
        {
            EditorGUILayout.HelpBox(
                "Drag in the straight and 90° corner tiles from the road kit.\n\n" +
                "Suggested: Road1 (straight) and Road10_90angle_Corner (corner).\n\n" +
                "Tiles are placed on their native 12 m grid, so the loop always closes.",
                MessageType.Info);

            EditorGUILayout.Space();

            straightTile = (GameObject)EditorGUILayout.ObjectField("Straight tile", straightTile, typeof(GameObject), false);
            cornerTile = (GameObject)EditorGUILayout.ObjectField("Corner tile", cornerTile, typeof(GameObject), false);

            EditorGUILayout.Space();

            longSide = Mathf.Max(1, EditorGUILayout.IntField("Long side (tiles)", longSide));
            shortSide = Mathf.Max(1, EditorGUILayout.IntField("Short side (tiles)", shortSide));

            cornerYawOffset = EditorGUILayout.IntPopup("Corner rotation", cornerYawOffset,
                new[] { "0°", "90°", "180°", "270°" }, new[] { 0, 90, 180, 270 });

            clockwise = EditorGUILayout.Toggle("Clockwise", clockwise);

            EditorGUILayout.Space();
            buildFurniture = EditorGUILayout.Toggle("Place race furniture", buildFurniture);
            removeExistingTrack = EditorGUILayout.Toggle("Remove existing track", removeExistingTrack);

            EditorGUILayout.Space();

            float lapLength = ((longSide + shortSide) * 2 + 4) * Grid;
            EditorGUILayout.LabelField($"Lap length ≈ {lapLength:N0} m",
                EditorStyles.miniLabel);

            EditorGUILayout.Space();

            using (new EditorGUI.DisabledScope(straightTile == null || cornerTile == null))
            {
                if (GUILayout.Button("Build Track", GUILayout.Height(36f))) Build();
            }

            if (straightTile == null || cornerTile == null)
            {
                EditorGUILayout.HelpBox("Pick both a straight and a corner tile.", MessageType.Warning);
            }
        }

        /// <summary>One placed tile: where it sits and which way traffic flows through it.</summary>
        private struct Cell
        {
            public Vector3 Position;
            public int Direction;     // 0 = +Z, 1 = +X, 2 = -Z, 3 = -X
            public bool IsCorner;
        }

        private static Vector3 DirectionToVector(int d)
        {
            switch (((d % 4) + 4) % 4)
            {
                case 0: return Vector3.forward;
                case 1: return Vector3.right;
                case 2: return Vector3.back;
                default: return Vector3.left;
            }
        }

        private void Build()
        {
            if (removeExistingTrack)
            {
                foreach (string name in new[] { "Track", "ModularTrack" })
                {
                    GameObject old = GameObject.Find(name);
                    if (old != null) DestroyImmediate(old);
                }
            }

            var root = new GameObject("ModularTrack");
            var cells = new List<Cell>();

            // Walk the rectangle. Four sides, each a run of straights followed by one
            // corner that turns onto the next side.
            int[] runs = { longSide, shortSide, longSide, shortSide };
            int turn = clockwise ? 1 : -1;

            var cursor = Vector3.zero;
            int dir = 0;

            for (int side = 0; side < 4; side++)
            {
                for (int i = 0; i < runs[side]; i++)
                {
                    cells.Add(new Cell { Position = cursor, Direction = dir, IsCorner = false });
                    cursor += DirectionToVector(dir) * Grid;
                }

                // The corner occupies the cell the run ends on. Turn first, then step off
                // along the new heading — which is what makes the four sides sum to zero
                // and the loop close exactly.
                cells.Add(new Cell { Position = cursor, Direction = dir, IsCorner = true });
                dir += turn;
                cursor += DirectionToVector(dir) * Grid;
            }

            var tilesRoot = new GameObject("Tiles");
            tilesRoot.transform.SetParent(root.transform, false);

            for (int i = 0; i < cells.Count; i++)
            {
                Cell cell = cells[i];
                GameObject source = cell.IsCorner ? cornerTile : straightTile;
                var tile = (GameObject)PrefabUtility.InstantiatePrefab(source);

                tile.transform.SetParent(tilesRoot.transform, false);
                tile.transform.position = cell.Position;

                float yaw = cell.Direction * 90f + (cell.IsCorner ? cornerYawOffset : 0f);
                tile.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
                tile.name = (cell.IsCorner ? "Corner_" : "Straight_") + i;
            }

            if (buildFurniture) BuildFurniture(root.transform, cells);

            Selection.activeGameObject = root;

            Debug.Log($"[Raceland] Modular track built: {cells.Count} tiles on a {Grid} m grid, " +
                      $"lap ≈ {cells.Count * Grid:N0} m.\n" +
                      "If the corners don't line up with the straights, step 'Corner rotation' " +
                      "by 90 and rebuild — the kit's corner connects two specific edges.");
        }

        private void BuildFurniture(Transform root, List<Cell> cells)
        {
            // Straights only: a gate or a pad on a corner tile is both hard to hit and
            // hard to respawn onto facing the right way.
            var straights = new List<Cell>();
            foreach (Cell c in cells) if (!c.IsCorner) straights.Add(c);
            if (straights.Count < 6) return;

            var furniture = new GameObject("RaceFurniture");
            furniture.transform.SetParent(root, false);

            Cell startCell = straights[0];
            FinishLine finish = MakeFinishLine(furniture.transform, startCell);

            var checkpoints = new List<Checkpoint>();
            for (int i = 1; i <= 4; i++)
            {
                Cell c = straights[Mathf.RoundToInt(straights.Count * (i / 5f))];
                checkpoints.Add(MakeCheckpoint(furniture.transform, c, i - 1));
            }

            for (int i = 1; i <= 3; i++)
            {
                Cell c = straights[Mathf.RoundToInt(straights.Count * (i / 4f)) % straights.Count];
                MakeBoostPad(furniture.transform, c);
            }

            RaceManager race = FindObjectOfType<RaceManager>();
            if (race != null)
            {
                race.SetPrivateObject("finishLine", finish);
                race.SetPrivateObjectArray("checkpoints", checkpoints.ToArray());

                BuggyController buggy = FindObjectOfType<BuggyController>();
                if (buggy != null)
                {
                    race.SetPrivateObject("buggy", buggy);
                    buggy.Teleport(startCell.Position + Vector3.up * 1.2f,
                        Quaternion.Euler(0f, startCell.Direction * 90f, 0f));
                }
            }
            else
            {
                Debug.LogWarning("[Raceland] No RaceManager in the scene — the track was built " +
                                 "but nothing is wired to time a lap on it.");
            }
        }

        private static FinishLine MakeFinishLine(Transform parent, Cell cell)
        {
            var go = new GameObject("FinishLine");
            go.transform.SetParent(parent, false);
            go.transform.position = cell.Position + Vector3.up * 2f;
            go.transform.rotation = Quaternion.Euler(0f, cell.Direction * 90f, 0f);

            var trigger = go.AddComponent<BoxCollider>();
            trigger.isTrigger = true;
            trigger.size = new Vector3(DrivableWidth, 8f, 2f);

            var grid = new GameObject("GridAnchor");
            grid.transform.SetParent(go.transform, false);
            grid.transform.position = cell.Position;
            grid.transform.rotation = go.transform.rotation;

            FinishLine finish = go.AddComponent<FinishLine>();
            finish.SetPrivateObject("gridAnchor", grid.transform);
            return finish;
        }

        private static Checkpoint MakeCheckpoint(Transform parent, Cell cell, int index)
        {
            var go = new GameObject($"Checkpoint_{index}");
            go.transform.SetParent(parent, false);
            go.transform.position = cell.Position + Vector3.up * 2f;
            go.transform.rotation = Quaternion.Euler(0f, cell.Direction * 90f, 0f);

            var trigger = go.AddComponent<BoxCollider>();
            trigger.isTrigger = true;

            // Generous: a buggy arriving sideways or airborne still has to count.
            trigger.size = new Vector3(DrivableWidth + 4f, 10f, 2f);

            var anchor = new GameObject("RespawnAnchor");
            anchor.transform.SetParent(go.transform, false);
            anchor.transform.position = cell.Position;
            anchor.transform.rotation = go.transform.rotation;

            Checkpoint checkpoint = go.AddComponent<Checkpoint>();
            checkpoint.SetPrivateInt("index", index);
            checkpoint.SetPrivateObject("respawnAnchor", anchor.transform);
            return checkpoint;
        }

        private static void MakeBoostPad(Transform parent, Cell cell)
        {
            var go = new GameObject("BoostPad");
            go.transform.SetParent(parent, false);
            go.transform.position = cell.Position + Vector3.up * 0.6f;
            go.transform.rotation = Quaternion.Euler(0f, cell.Direction * 90f, 0f);

            var trigger = go.AddComponent<BoxCollider>();
            trigger.isTrigger = true;
            trigger.size = new Vector3(6f, 2f, 5f);

            go.AddComponent<BoostPad>();
        }
    }
}
