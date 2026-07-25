using System.Collections.Generic;
using System.IO;
using Raceland.CameraRig;
using Raceland.Core;
using Raceland.Gameplay;
using Raceland.Track;
using Raceland.Vehicle;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Builds a complete, playable wasteland circuit out of Unity primitives.
    ///
    /// The point of this is sequencing. The brief has art generation (Rodin, Blender)
    /// ahead of the Unity work, but the physics is the risky part — it's the thing that
    /// either feels good or doesn't, and no amount of art rescues a buggy that drives
    /// badly. This builder means the handling, camera, damage and race loop can all be
    /// tuned on grey boxes while the art pipeline runs in parallel, and the Rodin meshes
    /// swap in later against physics that's already proven.
    ///
    /// Everything it makes is ordinary scene objects, so replacing a grey box with a real
    /// mesh is a normal art task, not a code change.
    /// </summary>
    public static class RacelandSceneBuilder
    {
        private const string ScenePath = "Assets/_Project/Scenes/Raceland_Track01.unity";
        private const string MaterialFolder = "Assets/_Project/Materials";

        // Track shape. An irregular closed loop rather than a plain oval: the wobble term
        // gives corners of genuinely different radius, which is what makes a lap
        // interesting to learn.
        private const float TrackRadiusX = 95f;
        private const float TrackRadiusZ = 62f;
        private const float TrackWobble = 14f;
        private const int TrackSegments = 72;
        private const float RoadWidth = 16f;

        // Road slabs are centred at this Y and 0.4 thick, so the drivable surface sits at
        // 0.25. Checkpoint and grid anchors are authored at y = 0 (the centreline), and
        // RespawnController lifts the buggy by its respawnHeightOffset (1.2) when placing
        // it — which clears both the surface and the buggy's own ~0.87 resting height.
        // Change either number and they have to be reconciled, or the buggy spawns inside
        // the road.
        private const float RoadSurfaceY = 0.05f;

        [MenuItem("Raceland/Build Playable Grey-Box Track", priority = 40)]
        public static void BuildScene()
        {
            if (!EditorUtility.DisplayDialog(
                    "Build Raceland grey-box track",
                    "This creates a new scene at:\n" + ScenePath +
                    "\n\nAny existing scene at that path is overwritten. Continue?",
                    "Build it", "Cancel"))
            {
                return;
            }

            RacelandLayers.EnsureLayersExist();

            Scene scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene, NewSceneMode.Single);

            BuildEnvironment();

            Vector3 startPosition = PointOnTrack(0f);
            Quaternion startRotation = Quaternion.LookRotation(TangentOnTrack(0f), Vector3.up);

            GameObject trackRoot = BuildRoad();
            FinishLine finish = BuildFinishLine(startPosition, startRotation, trackRoot.transform);
            Checkpoint[] checkpoints = BuildCheckpoints(trackRoot.transform);

            BuildBoostPads(trackRoot.transform);
            BuildKicker(trackRoot.transform);
            BuildObstacles(trackRoot.transform);
            BuildScenery(trackRoot.transform);

            BuggyController buggy = BuildBuggy(startPosition + Vector3.up * 1.2f, startRotation);
            BuildCamera(buggy);
            BuildRaceManager(buggy, finish, checkpoints);

            var hub = new GameObject("VehicleInputHub");
            hub.AddComponent<VehicleInputHub>();

            var bootstrap = new GameObject("PerformanceBootstrap");
            bootstrap.AddComponent<PerformanceBootstrap>();

            RacelandUIBuilder.BuildUI(buggy);

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath)!);
            EditorSceneManager.SaveScene(scene, ScenePath);

            Debug.Log($"[Raceland] Grey-box track built and saved to {ScenePath}.\n" +
                      "Press Play. Drive with WASD (or the on-screen buttons), Shift to boost, " +
                      "Space to handbrake, R to respawn.");
        }

        // ---- Track geometry -------------------------------------------------------

        private static Vector3 PointOnTrack(float t)
        {
            float angle = t * Mathf.PI * 2f;
            float wobble = Mathf.Sin(angle * 3f) * TrackWobble;

            return new Vector3(
                Mathf.Cos(angle) * (TrackRadiusX + wobble),
                0f,
                Mathf.Sin(angle) * (TrackRadiusZ + wobble));
        }

        private static Vector3 TangentOnTrack(float t)
        {
            // Numeric tangent. The wobble makes an analytic derivative fiddly and this is
            // an editor-time call, so precision beats elegance.
            const float step = 0.001f;
            Vector3 direction = PointOnTrack(t + step) - PointOnTrack(t - step);
            direction.y = 0f;
            return direction.normalized;
        }

        private static Vector3 RightOnTrack(float t)
        {
            return Vector3.Cross(Vector3.up, TangentOnTrack(t)).normalized;
        }

        // ---- Environment ----------------------------------------------------------

        private static void BuildEnvironment()
        {
            var sunObject = new GameObject("Sun");
            Light sun = sunObject.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.87f, 0.68f);   // Warm, low desert sun.
            sun.intensity = 1.25f;
            sun.shadows = LightShadows.Soft;
            sunObject.transform.rotation = Quaternion.Euler(38f, 145f, 0f);

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.72f, 0.58f, 0.42f);
            RenderSettings.ambientEquatorColor = new Color(0.55f, 0.44f, 0.33f);
            RenderSettings.ambientGroundColor = new Color(0.33f, 0.27f, 0.21f);

            // Dusty fog: fits the theme and cuts draw distance, which is the cheapest
            // performance win available on a phone.
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = new Color(0.83f, 0.66f, 0.45f);
            RenderSettings.fogStartDistance = 60f;
            RenderSettings.fogEndDistance = 320f;

            GameObject ground = GameObject.CreatePrimitive(PrimitiveType.Cube);
            ground.name = "Desert Floor";
            ground.transform.localScale = new Vector3(520f, 2f, 520f);
            ground.transform.position = new Vector3(0f, -1f, 0f);
            ground.layer = LayerMask.NameToLayer(RacelandLayers.Ground);
            ApplyMaterial(ground, "Sand", new Color(0.76f, 0.62f, 0.42f));
        }

        private static GameObject BuildRoad()
        {
            var root = new GameObject("Track");
            var roadRoot = new GameObject("Road");
            roadRoot.transform.SetParent(root.transform);

            Material asphalt = GetMaterial("Cracked Asphalt", new Color(0.29f, 0.27f, 0.25f));
            int groundLayer = LayerMask.NameToLayer(RacelandLayers.Ground);

            for (int i = 0; i < TrackSegments; i++)
            {
                float t0 = i / (float)TrackSegments;
                float t1 = (i + 1) / (float)TrackSegments;

                Vector3 a = PointOnTrack(t0);
                Vector3 b = PointOnTrack(t1);
                Vector3 mid = (a + b) * 0.5f;
                float length = Vector3.Distance(a, b);

                GameObject segment = GameObject.CreatePrimitive(PrimitiveType.Cube);
                segment.name = $"Road_{i:00}";
                segment.transform.SetParent(roadRoot.transform);
                segment.transform.position = mid + Vector3.up * RoadSurfaceY;
                segment.transform.rotation = Quaternion.LookRotation((b - a).normalized, Vector3.up);

                // Slight overlap on length stops hairline gaps at segment joins, which the
                // suspension raycast would otherwise drop through at speed.
                segment.transform.localScale = new Vector3(RoadWidth, 0.4f, length * 1.05f);
                segment.layer = groundLayer;
                segment.GetComponent<Renderer>().sharedMaterial = asphalt;

                // Static batching: the road never moves and is most of the scene's draw calls.
                GameObjectUtility.SetStaticEditorFlags(segment, StaticEditorFlags.BatchingStatic);
            }

            BuildBarriers(root.transform);
            return root;
        }

        private static void BuildBarriers(Transform parent)
        {
            var barrierRoot = new GameObject("Barriers");
            barrierRoot.transform.SetParent(parent);

            Material rust = GetMaterial("Rusted Metal", new Color(0.45f, 0.25f, 0.15f));
            int groundLayer = LayerMask.NameToLayer(RacelandLayers.Ground);

            // Low walls on both sides. They exist to keep the player on the circuit
            // without being tall enough to hide the horizon.
            for (int i = 0; i < TrackSegments; i++)
            {
                float t0 = i / (float)TrackSegments;
                float t1 = (i + 1) / (float)TrackSegments;

                for (int side = -1; side <= 1; side += 2)
                {
                    Vector3 a = PointOnTrack(t0) + RightOnTrack(t0) * (RoadWidth * 0.5f * side);
                    Vector3 b = PointOnTrack(t1) + RightOnTrack(t1) * (RoadWidth * 0.5f * side);

                    GameObject wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    wall.name = $"Barrier_{(side < 0 ? "L" : "R")}_{i:00}";
                    wall.transform.SetParent(barrierRoot.transform);
                    wall.transform.position = (a + b) * 0.5f + Vector3.up * 0.6f;
                    wall.transform.rotation = Quaternion.LookRotation((b - a).normalized, Vector3.up);
                    wall.transform.localScale = new Vector3(0.5f, 1.2f, Vector3.Distance(a, b) * 1.05f);
                    wall.layer = groundLayer;
                    wall.GetComponent<Renderer>().sharedMaterial = rust;

                    GameObjectUtility.SetStaticEditorFlags(wall, StaticEditorFlags.BatchingStatic);
                }
            }
        }

        // ---- Race furniture -------------------------------------------------------

        private static FinishLine BuildFinishLine(Vector3 position, Quaternion rotation, Transform parent)
        {
            var finishObject = new GameObject("FinishLine");
            finishObject.transform.SetParent(parent);
            finishObject.transform.SetPositionAndRotation(position + Vector3.up * 2f, rotation);

            var trigger = finishObject.AddComponent<BoxCollider>();
            trigger.isTrigger = true;
            trigger.size = new Vector3(RoadWidth, 8f, 2f);

            var grid = new GameObject("GridAnchor");
            grid.transform.SetParent(finishObject.transform);
            grid.transform.SetPositionAndRotation(position, rotation);

            FinishLine finish = finishObject.AddComponent<FinishLine>();
            finish.SetPrivateObject("gridAnchor", grid.transform);

            // A visible gantry so the line reads at speed.
            GameObject gantry = GameObject.CreatePrimitive(PrimitiveType.Cube);
            gantry.name = "Gantry";
            gantry.transform.SetParent(finishObject.transform);
            gantry.transform.SetPositionAndRotation(position + Vector3.up * 6f, rotation);
            gantry.transform.localScale = new Vector3(RoadWidth + 2f, 1f, 0.6f);
            Object.DestroyImmediate(gantry.GetComponent<Collider>());
            ApplyMaterial(gantry, "Finish Green", new Color(0.35f, 0.75f, 0.35f));

            return finish;
        }

        private static Checkpoint[] BuildCheckpoints(Transform parent)
        {
            var root = new GameObject("Checkpoints");
            root.transform.SetParent(parent);

            // Four gates spread evenly around the lap. Enough to make cutting the course
            // impossible without being so dense that respawns feel like a rewind.
            float[] positions = { 0.2f, 0.4f, 0.6f, 0.8f };
            var checkpoints = new List<Checkpoint>();

            for (int i = 0; i < positions.Length; i++)
            {
                float t = positions[i];
                Vector3 position = PointOnTrack(t);
                Quaternion rotation = Quaternion.LookRotation(TangentOnTrack(t), Vector3.up);

                var gate = new GameObject($"Checkpoint_{i}");
                gate.transform.SetParent(root.transform);
                gate.transform.SetPositionAndRotation(position + Vector3.up * 2f, rotation);

                var trigger = gate.AddComponent<BoxCollider>();
                trigger.isTrigger = true;

                // Wide and tall on purpose: a buggy arriving sideways, airborne or upside
                // down still has to count as passing through.
                trigger.size = new Vector3(RoadWidth + 4f, 10f, 2f);

                var anchor = new GameObject("RespawnAnchor");
                anchor.transform.SetParent(gate.transform);
                anchor.transform.SetPositionAndRotation(position, rotation);

                GameObject post = GameObject.CreatePrimitive(PrimitiveType.Cube);
                post.name = "Marker";
                post.transform.SetParent(gate.transform);
                post.transform.SetPositionAndRotation(position + Vector3.up * 4f, rotation);
                post.transform.localScale = new Vector3(RoadWidth, 0.5f, 0.4f);
                Object.DestroyImmediate(post.GetComponent<Collider>());
                ApplyMaterial(post, "Checkpoint Orange", new Color(1f, 0.62f, 0.15f));

                Checkpoint checkpoint = gate.AddComponent<Checkpoint>();
                checkpoint.SetPrivateInt("index", i);
                checkpoint.SetPrivateObject("respawnAnchor", anchor.transform);
                checkpoint.SetPrivateObject("indicator", post.GetComponent<Renderer>());

                checkpoints.Add(checkpoint);
            }

            return checkpoints.ToArray();
        }

        private static void BuildBoostPads(Transform parent)
        {
            var root = new GameObject("BoostPads");
            root.transform.SetParent(parent);

            float[] positions = { 0.1f, 0.55f, 0.87f };

            foreach (float t in positions)
            {
                Vector3 position = PointOnTrack(t);
                Quaternion rotation = Quaternion.LookRotation(TangentOnTrack(t), Vector3.up);

                var pad = new GameObject($"BoostPad_{t:0.00}");
                pad.transform.SetParent(root.transform);
                pad.transform.SetPositionAndRotation(position + Vector3.up * 0.6f, rotation);

                var trigger = pad.AddComponent<BoxCollider>();
                trigger.isTrigger = true;
                trigger.size = new Vector3(7f, 2f, 5f);

                GameObject strip = GameObject.CreatePrimitive(PrimitiveType.Cube);
                strip.name = "GlowStrip";
                strip.transform.SetParent(pad.transform);
                strip.transform.SetPositionAndRotation(position + Vector3.up * 0.3f, rotation);
                strip.transform.localScale = new Vector3(7f, 0.15f, 5f);
                Object.DestroyImmediate(strip.GetComponent<Collider>());

                Material glow = GetMaterial("Boost Glow", new Color(1f, 0.55f, 0.1f), emissive: true);
                strip.GetComponent<Renderer>().sharedMaterial = glow;

                BoostPad boostPad = pad.AddComponent<BoostPad>();
                boostPad.SetPrivateObject("glowStrip", strip.GetComponent<Renderer>());
            }
        }

        private static void BuildKicker(Transform parent)
        {
            const float t = 0.3f;

            Vector3 position = PointOnTrack(t);
            Quaternion rotation = Quaternion.LookRotation(TangentOnTrack(t), Vector3.up);

            GameObject ramp = GameObject.CreatePrimitive(PrimitiveType.Cube);
            ramp.name = "JumpKicker";
            ramp.transform.SetParent(parent);
            ramp.transform.SetPositionAndRotation(position + Vector3.up * 0.9f, rotation);

            // Tilted slab. A wedge mesh would be tidier, but a rotated box gives a clean
            // ramp face and the suspension only ever sees the top surface anyway.
            ramp.transform.rotation = rotation * Quaternion.Euler(-16f, 0f, 0f);
            ramp.transform.localScale = new Vector3(RoadWidth - 2f, 0.6f, 12f);
            ramp.layer = LayerMask.NameToLayer(RacelandLayers.Ground);
            ApplyMaterial(ramp, "Dirt Mound", new Color(0.52f, 0.4f, 0.27f));

            GameObjectUtility.SetStaticEditorFlags(ramp, StaticEditorFlags.BatchingStatic);
        }

        private static void BuildObstacles(Transform parent)
        {
            var root = new GameObject("Obstacles");
            root.transform.SetParent(parent);

            Material wreck = GetMaterial("Burnt Wreck", new Color(0.22f, 0.2f, 0.19f));
            int obstacleLayer = LayerMask.NameToLayer(RacelandLayers.Obstacle);
            int debrisLayer = LayerMask.NameToLayer(RacelandLayers.Debris);

            // Scattered across the racing line at varying offsets so they have to be
            // driven around (or through) rather than ignored.
            (float t, float offset)[] placements =
            {
                (0.05f, -3.5f), (0.15f, 3f), (0.25f, 0f), (0.35f, -4f),
                (0.45f, 2.5f), (0.5f, -2f), (0.65f, 3.5f), (0.7f, -3f),
                (0.78f, 1.5f), (0.92f, -2.5f)
            };

            for (int i = 0; i < placements.Length; i++)
            {
                (float t, float offset) = placements[i];

                Vector3 position = PointOnTrack(t) + RightOnTrack(t) * offset + Vector3.up * 0.9f;
                Quaternion rotation = Quaternion.LookRotation(TangentOnTrack(t), Vector3.up);

                var obstacle = new GameObject($"Wreck_{i:00}");
                obstacle.transform.SetParent(root.transform);
                obstacle.transform.SetPositionAndRotation(position, rotation);
                obstacle.layer = obstacleLayer;

                // The root carries the collider and rigidbody so collision impulses are
                // reported against the whole obstacle, not one of the halves.
                var collider = obstacle.AddComponent<BoxCollider>();
                collider.size = new Vector3(2.4f, 1.8f, 4f);

                var body = obstacle.AddComponent<Rigidbody>();
                body.mass = 400f;
                body.isKinematic = true;

                GameObject intact = GameObject.CreatePrimitive(PrimitiveType.Cube);
                intact.name = "Intact";
                intact.transform.SetParent(obstacle.transform);
                intact.transform.localPosition = Vector3.zero;
                intact.transform.localRotation = Quaternion.identity;
                intact.transform.localScale = new Vector3(2.4f, 1.8f, 4f);
                Object.DestroyImmediate(intact.GetComponent<Collider>());
                intact.GetComponent<Renderer>().sharedMaterial = wreck;

                var halves = new GameObject[2];

                for (int half = 0; half < 2; half++)
                {
                    GameObject piece = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    piece.name = $"Half_{half}";
                    piece.transform.SetParent(obstacle.transform);
                    piece.transform.localRotation = Quaternion.identity;
                    piece.transform.localScale = new Vector3(2.4f, 1.8f, 1.95f);
                    piece.transform.localPosition = new Vector3(0f, 0f, half == 0 ? -1f : 1f);
                    piece.layer = debrisLayer;
                    piece.GetComponent<Renderer>().sharedMaterial = wreck;
                    piece.SetActive(false);

                    halves[half] = piece;
                }

                Destructible destructible = obstacle.AddComponent<Destructible>();
                destructible.SetPrivateObject("intact", intact);
                destructible.SetPrivateObjectArray("halves", halves);
                destructible.SetPrivateInt("debrisLayer", debrisLayer);
            }
        }

        private static void BuildScenery(Transform parent)
        {
            var root = new GameObject("Scenery");
            root.transform.SetParent(parent);

            Material rust = GetMaterial("Rusted Metal", new Color(0.45f, 0.25f, 0.15f));

            // Roadside billboards. Their only job is to stream past the camera — without
            // vertical landmarks a flat desert reads as barely moving.
            for (int i = 0; i < 14; i++)
            {
                float t = i / 14f;
                float side = i % 2 == 0 ? 1f : -1f;

                Vector3 basePosition = PointOnTrack(t) + RightOnTrack(t) * (RoadWidth * 0.5f + 7f) * side;
                Quaternion rotation = Quaternion.LookRotation(TangentOnTrack(t), Vector3.up);

                var billboard = new GameObject($"Billboard_{i:00}");
                billboard.transform.SetParent(root.transform);
                billboard.transform.SetPositionAndRotation(basePosition, rotation);

                GameObject post = GameObject.CreatePrimitive(PrimitiveType.Cube);
                post.name = "Post";
                post.transform.SetParent(billboard.transform);
                post.transform.localPosition = new Vector3(0f, 3f, 0f);
                post.transform.localScale = new Vector3(0.4f, 6f, 0.4f);
                post.GetComponent<Renderer>().sharedMaterial = rust;

                GameObject panel = GameObject.CreatePrimitive(PrimitiveType.Cube);
                panel.name = "Panel";
                panel.transform.SetParent(billboard.transform);
                panel.transform.localPosition = new Vector3(0f, 6.5f, 0f);
                panel.transform.localRotation = Quaternion.Euler(0f, 0f, side * 5f);
                panel.transform.localScale = new Vector3(7f, 3.5f, 0.3f);
                Object.DestroyImmediate(panel.GetComponent<Collider>());
                panel.GetComponent<Renderer>().sharedMaterial = rust;

                GameObjectUtility.SetStaticEditorFlags(billboard, StaticEditorFlags.BatchingStatic);
            }
        }

        // ---- Vehicle ---------------------------------------------------------------

        private static BuggyController BuildBuggy(Vector3 position, Quaternion rotation)
        {
            int vehicleLayer = LayerMask.NameToLayer(RacelandLayers.Vehicle);
            int debrisLayer = LayerMask.NameToLayer(RacelandLayers.Debris);

            var buggyObject = new GameObject("Buggy");
            buggyObject.transform.SetPositionAndRotation(position, rotation);
            buggyObject.layer = vehicleLayer;
            buggyObject.tag = RacelandLayers.PlayerTag;

            var body = buggyObject.AddComponent<Rigidbody>();
            body.mass = 1200f;
            body.drag = 0.05f;
            body.angularDrag = 2.5f;

            var chassisCollider = buggyObject.AddComponent<BoxCollider>();
            chassisCollider.size = new Vector3(2.2f, 1.2f, 4.2f);
            chassisCollider.center = new Vector3(0f, 0.2f, 0f);

            Material chassisMaterial = GetMaterial("Buggy Body", new Color(0.55f, 0.33f, 0.2f));

            GameObject chassisVisual = GameObject.CreatePrimitive(PrimitiveType.Cube);
            chassisVisual.name = "ChassisVisual";
            chassisVisual.transform.SetParent(buggyObject.transform);
            chassisVisual.transform.localPosition = new Vector3(0f, 0.2f, 0f);
            chassisVisual.transform.localRotation = Quaternion.identity;
            chassisVisual.transform.localScale = new Vector3(2.2f, 1.2f, 4.2f);
            chassisVisual.layer = vehicleLayer;
            Object.DestroyImmediate(chassisVisual.GetComponent<Collider>());
            chassisVisual.GetComponent<Renderer>().sharedMaterial = chassisMaterial;

            // A nose block, so which way the buggy is pointing is obvious on grey boxes.
            GameObject nose = GameObject.CreatePrimitive(PrimitiveType.Cube);
            nose.name = "RamBumper";
            nose.transform.SetParent(buggyObject.transform);
            nose.transform.localPosition = new Vector3(0f, 0f, 2.2f);
            nose.transform.localRotation = Quaternion.identity;
            nose.transform.localScale = new Vector3(2.4f, 0.6f, 0.5f);
            nose.layer = vehicleLayer;
            Object.DestroyImmediate(nose.GetComponent<Collider>());
            nose.GetComponent<Renderer>().sharedMaterial =
                GetMaterial("Scrap Steel", new Color(0.38f, 0.36f, 0.34f));

            var wheelRoot = new GameObject("Wheels");
            wheelRoot.transform.SetParent(buggyObject.transform);
            wheelRoot.transform.localPosition = Vector3.zero;
            wheelRoot.transform.localRotation = Quaternion.identity;

            var anchors = new Transform[4];
            var pivots = new Transform[4];

            // Index order matters: the anti-roll bar pairs 0-1 (front) and 2-3 (rear).
            (string name, float x, float z)[] corners =
            {
                ("FrontLeft", -1.15f, 1.5f),
                ("FrontRight", 1.15f, 1.5f),
                ("RearLeft", -1.15f, -1.5f),
                ("RearRight", 1.15f, -1.5f)
            };

            Material tyreMaterial = GetMaterial("Tyre", new Color(0.13f, 0.12f, 0.12f));

            for (int i = 0; i < corners.Length; i++)
            {
                (string name, float x, float z) = corners[i];

                var anchor = new GameObject($"Anchor_{name}");
                anchor.transform.SetParent(wheelRoot.transform);
                anchor.transform.localPosition = new Vector3(x, 0.25f, z);
                anchor.transform.localRotation = Quaternion.identity;
                anchors[i] = anchor.transform;

                // The pivot is what WheelVisual drives. The mesh hangs off it with a local
                // rotation, so the wheel can spin about its own axle without the code
                // needing to know how the mesh happens to be oriented — exactly how a
                // Rodin/Blender wheel will be parented later.
                var pivot = new GameObject($"Wheel_{name}");
                pivot.transform.SetParent(wheelRoot.transform);
                pivot.transform.position = anchor.transform.position - buggyObject.transform.up * 0.55f;
                pivot.transform.rotation = buggyObject.transform.rotation;
                pivots[i] = pivot.transform;

                GameObject mesh = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                mesh.name = "Mesh";
                mesh.transform.SetParent(pivot.transform);
                mesh.transform.localPosition = Vector3.zero;
                mesh.transform.localRotation = Quaternion.Euler(0f, 0f, 90f);

                // Cylinder is 2 units tall with radius 0.5, so 0.9 scale = 0.45 radius.
                mesh.transform.localScale = new Vector3(0.9f, 0.18f, 0.9f);
                mesh.layer = vehicleLayer;
                Object.DestroyImmediate(mesh.GetComponent<Collider>());
                mesh.GetComponent<Renderer>().sharedMaterial = tyreMaterial;
            }

            // Bang Parts stand-ins: panels that tear off on a hard enough hit.
            var panelRoot = new GameObject("Panels");
            panelRoot.transform.SetParent(buggyObject.transform);
            panelRoot.transform.localPosition = Vector3.zero;
            panelRoot.transform.localRotation = Quaternion.identity;

            (string name, Vector3 localPosition, Vector3 scale, float impulse)[] panelSpecs =
            {
                ("Panel_Left", new Vector3(-1.2f, 0.3f, 0.2f), new Vector3(0.2f, 0.9f, 2.6f), 45f),
                ("Panel_Right", new Vector3(1.2f, 0.3f, 0.2f), new Vector3(0.2f, 0.9f, 2.6f), 45f),
                ("Panel_Bonnet", new Vector3(0f, 0.85f, 1.2f), new Vector3(1.9f, 0.2f, 1.6f), 55f),
                ("Panel_Bumper", new Vector3(0f, -0.1f, 2.45f), new Vector3(2.3f, 0.5f, 0.3f), 70f)
            };

            var panels = new Transform[panelSpecs.Length];

            for (int i = 0; i < panelSpecs.Length; i++)
            {
                (string name, Vector3 localPosition, Vector3 scale, float _) = panelSpecs[i];

                GameObject panel = GameObject.CreatePrimitive(PrimitiveType.Cube);
                panel.name = name;
                panel.transform.SetParent(panelRoot.transform);
                panel.transform.localPosition = localPosition;
                panel.transform.localRotation = Quaternion.identity;
                panel.transform.localScale = scale;
                panel.layer = vehicleLayer;

                // No collider while attached: the chassis box already covers the vehicle's
                // shape, and panel colliders would add cost for no benefit.
                Object.DestroyImmediate(panel.GetComponent<Collider>());
                panel.GetComponent<Renderer>().sharedMaterial = chassisMaterial;

                panels[i] = panel.transform;
            }

            BuggyController controller = buggyObject.AddComponent<BuggyController>();

            var serialized = new SerializedObject(controller);
            SerializedProperty wheelsProperty = serialized.FindProperty("wheels");
            wheelsProperty.arraySize = 4;

            for (int i = 0; i < 4; i++)
            {
                SerializedProperty element = wheelsProperty.GetArrayElementAtIndex(i);
                element.FindPropertyRelative("anchor").objectReferenceValue = anchors[i];
                element.FindPropertyRelative("visual").objectReferenceValue = pivots[i];
                element.FindPropertyRelative("steers").boolValue = i < 2;
                element.FindPropertyRelative("powered").boolValue = true;
                element.FindPropertyRelative("radius").floatValue = 0.45f;
            }

            // Cast against the ground only. Including the vehicle layer here makes the
            // buggy detect its own bodywork and hover.
            serialized.FindProperty("groundMask").intValue =
                1 << LayerMask.NameToLayer(RacelandLayers.Ground) |
                1 << LayerMask.NameToLayer(RacelandLayers.Obstacle);

            serialized.ApplyModifiedPropertiesWithoutUndo();

            buggyObject.AddComponent<WheelVisual>();
            buggyObject.AddComponent<BoostSystem>();

            DamageableBody damage = buggyObject.AddComponent<DamageableBody>();
            var damageSerialized = new SerializedObject(damage);
            SerializedProperty panelsProperty = damageSerialized.FindProperty("panels");
            panelsProperty.arraySize = panels.Length;

            for (int i = 0; i < panels.Length; i++)
            {
                SerializedProperty element = panelsProperty.GetArrayElementAtIndex(i);
                element.FindPropertyRelative("target").objectReferenceValue = panels[i];
                element.FindPropertyRelative("detachImpulse").floatValue = panelSpecs[i].impulse;
            }

            damageSerialized.FindProperty("debrisLayer").intValue = debrisLayer;
            damageSerialized.ApplyModifiedPropertiesWithoutUndo();

            buggyObject.AddComponent<RespawnController>();

            StuntScorer scorer = buggyObject.AddComponent<StuntScorer>();
            scorer.SetPrivateLayerMask("nearMissMask", 1 << LayerMask.NameToLayer(RacelandLayers.Obstacle));

            // Audio sources with no clips: silent, but wired, so dropping in a WAV later is
            // a single inspector assignment rather than a scene rebuild.
            var engineSource = buggyObject.AddComponent<AudioSource>();
            engineSource.playOnAwake = false;
            engineSource.loop = true;

            var effectSource = buggyObject.AddComponent<AudioSource>();
            effectSource.playOnAwake = false;

            VehicleAudio audio = buggyObject.AddComponent<VehicleAudio>();
            audio.SetPrivateObject("engineSource", engineSource);
            audio.SetPrivateObject("effectSource", effectSource);

            return controller;
        }

        private static void BuildCamera(BuggyController buggy)
        {
            var cameraObject = new GameObject("ChaseCamera");
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.fieldOfView = 62f;
            camera.nearClipPlane = 0.3f;

            // Matches the fog end distance — drawing past the fog wall is wasted work.
            camera.farClipPlane = 340f;
            cameraObject.tag = "MainCamera";

            cameraObject.AddComponent<AudioListener>();

            ChaseCamera chase = cameraObject.AddComponent<ChaseCamera>();
            chase.SetPrivateObject("target", buggy);
        }

        private static void BuildRaceManager(BuggyController buggy, FinishLine finish, Checkpoint[] checkpoints)
        {
            var managerObject = new GameObject("RaceManager");
            RaceManager manager = managerObject.AddComponent<RaceManager>();

            manager.SetPrivateObject("finishLine", finish);
            manager.SetPrivateObject("buggy", buggy);
            manager.SetPrivateObjectArray("checkpoints", checkpoints);

            // The main menu drives the start, so don't begin a run on scene load.
            manager.SetPrivateBool("autoStart", false);
        }

        // ---- Materials -------------------------------------------------------------

        private static void ApplyMaterial(GameObject target, string name, Color colour)
        {
            target.GetComponent<Renderer>().sharedMaterial = GetMaterial(name, colour);
        }

        private static Material GetMaterial(string name, Color colour, bool emissive = false)
        {
            Directory.CreateDirectory(MaterialFolder);
            string path = $"{MaterialFolder}/{name.Replace(' ', '_')}.mat";

            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null) return existing;

            // URP first; fall back to Standard so the builder still works if someone runs
            // it before the pipeline is configured.
            Shader shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");

            var material = new Material(shader) { name = name };
            SetColour(material, colour);

            // Matte, dusty surfaces. A shiny wasteland reads as plastic.
            if (material.HasProperty("_Smoothness")) material.SetFloat("_Smoothness", 0.15f);
            if (material.HasProperty("_Glossiness")) material.SetFloat("_Glossiness", 0.15f);

            if (emissive)
            {
                material.EnableKeyword("_EMISSION");
                if (material.HasProperty("_EmissionColor"))
                {
                    material.SetColor("_EmissionColor", colour * 2f);
                }
            }

            AssetDatabase.CreateAsset(material, path);
            return material;
        }

        private static void SetColour(Material material, Color colour)
        {
            // URP uses _BaseColor, Built-in uses _Color. Set whichever exists so the same
            // builder works either side of the pipeline switch.
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", colour);
            if (material.HasProperty("_Color")) material.SetColor("_Color", colour);
        }
    }
}
