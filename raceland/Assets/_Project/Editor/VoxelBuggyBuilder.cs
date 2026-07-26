using Raceland.CameraRig;
using Raceland.Gameplay;
using Raceland.Track;
using Raceland.Vehicle;
using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Builds a physics-ready vehicle from a voxel chassis model and a voxel wheel model.
    ///
    /// Two problems this solves that would otherwise be manual, per-asset, and easy to get
    /// subtly wrong across 29 chassis and 30 wheel variants:
    ///
    /// 1. **Wheel pivots.** VoxEdit exports with the origin at the corner of the model's
    ///    bounding box, not at the axle. WheelVisual rotates a wheel about its pivot, so
    ///    an uncorrected wheel orbits around a point on the ground instead of spinning.
    ///    The fix is to nest the mesh under a pivot object and offset it by minus its own
    ///    bounds centre, which is exactly what a hand-authored wheel prefab would do.
    ///
    /// 2. **Physics that matches the art.** Wheel radius, wheelbase, track width, ride
    ///    height, spring rate and damping are all derived from the measured bounds of the
    ///    models you pick, rather than being constants that silently stop matching when
    ///    you swap in a different chassis.
    /// </summary>
    public class VoxelBuggyBuilder : EditorWindow
    {
        [SerializeField] private GameObject chassisModel;
        [SerializeField] private GameObject wheelModel;

        [SerializeField] private float mass = 1000f;

        [Tooltip("Gap between the bottom of the body shell and the ground, in metres.")]
        [SerializeField] private float groundClearance = 0.16f;

        [Tooltip("Static suspension compression as a fraction of rest length. The spring " +
                 "rate is solved backwards from this, so it stays correct at any mass.")]
        [Range(0.1f, 0.45f)]
        [SerializeField] private float staticCompression = 0.25f;

        [Tooltip("0 = undamped and bouncy, 1 = critically damped and dead. Arcade wants " +
                 "some overshoot.")]
        [Range(0.1f, 1f)]
        [SerializeField] private float dampingRatio = 0.5f;

        [Tooltip("Replace the buggy already in the scene, keeping its position and " +
                 "re-pointing the camera and race manager at the new one.")]
        [SerializeField] private bool replaceExisting = true;

        [MenuItem("Raceland/Build Buggy From Voxel Assets", priority = 42)]
        public static void ShowWindow()
        {
            var window = GetWindow<VoxelBuggyBuilder>(true, "Voxel Buggy Builder");
            window.minSize = new Vector2(420f, 340f);
        }

        private void OnGUI()
        {
            EditorGUILayout.HelpBox(
                "Drag in one chassis .obj and one wheel .obj from the imported voxel pack.\n\n" +
                "Everything else — wheel radius, wheelbase, ride height, spring rate — is " +
                "measured from those two models.",
                MessageType.Info);

            EditorGUILayout.Space();

            chassisModel = (GameObject)EditorGUILayout.ObjectField(
                "Chassis model", chassisModel, typeof(GameObject), false);
            wheelModel = (GameObject)EditorGUILayout.ObjectField(
                "Wheel model", wheelModel, typeof(GameObject), false);

            EditorGUILayout.Space();

            mass = EditorGUILayout.FloatField("Mass (kg)", mass);
            groundClearance = EditorGUILayout.FloatField("Ground clearance (m)", groundClearance);
            staticCompression = EditorGUILayout.Slider("Static compression", staticCompression, 0.1f, 0.45f);
            dampingRatio = EditorGUILayout.Slider("Damping ratio", dampingRatio, 0.1f, 1f);

            EditorGUILayout.Space();
            replaceExisting = EditorGUILayout.Toggle("Replace buggy in scene", replaceExisting);

            EditorGUILayout.Space();

            using (new EditorGUI.DisabledScope(chassisModel == null || wheelModel == null))
            {
                if (GUILayout.Button("Build Buggy", GUILayout.Height(36f))) Build();
            }

            if (chassisModel == null || wheelModel == null)
            {
                EditorGUILayout.HelpBox("Pick both a chassis and a wheel model.", MessageType.Warning);
            }
        }

        private void Build()
        {
            Bounds chassisBounds = MeasureModel(chassisModel, out bool chassisOk);
            Bounds wheelBounds = MeasureModel(wheelModel, out bool wheelOk);

            if (!chassisOk || !wheelOk)
            {
                Debug.LogError("[Raceland] Could not measure one of the models — no renderers found. " +
                               "Make sure you picked the imported .obj asset, not a folder.");
                return;
            }

            // The wheel is a disc: thin on its axle axis, round on the other two. Radius is
            // the larger of the two round extents, so it stays correct whichever way the
            // pack happens to orient a given wheel.
            float wheelRadius = Mathf.Max(wheelBounds.extents.y, wheelBounds.extents.z);
            float wheelWidth = wheelBounds.size.x;

            float bodyLength = chassisBounds.size.z;
            float bodyWidth = chassisBounds.size.x;
            float bodyHeight = chassisBounds.size.y;

            float restLength = wheelRadius * 1.15f;
            float maxTravel = restLength * 0.6f;

            // Spring solved from the load it has to hold, so the ride height is right at
            // any mass rather than being a magic number tuned for one car.
            float cornerMass = mass * 0.25f;
            float gravity = Mathf.Abs(Physics.gravity.y);
            if (gravity < 0.01f) gravity = 18f;

            float springStrength = cornerMass * gravity / (restLength * staticCompression);
            float springDamper = dampingRatio * 2f * Mathf.Sqrt(springStrength * cornerMass);

            // Root origin sits at the bottom of the body shell, so the ground is one
            // ground-clearance below it and the wheels tuck up into the arches.
            float wheelCentreAtRest = -groundClearance + wheelRadius;
            float anchorY = wheelCentreAtRest + (restLength * (1f - staticCompression));

            float anchorX = Mathf.Max(0.1f, bodyWidth * 0.5f - wheelWidth * 0.5f - 0.02f);
            float anchorZ = bodyLength * 0.32f;

            Vector3 spawnPosition = Vector3.zero;
            Quaternion spawnRotation = Quaternion.identity;
            BuggyController existing = FindObjectOfType<BuggyController>();

            if (existing != null && replaceExisting)
            {
                spawnPosition = existing.transform.position;
                spawnRotation = existing.transform.rotation;
            }

            int vehicleLayer = LayerMask.NameToLayer(RacelandLayers.Vehicle);
            int groundLayer = LayerMask.NameToLayer(RacelandLayers.Ground);
            int obstacleLayer = LayerMask.NameToLayer(RacelandLayers.Obstacle);

            if (vehicleLayer < 0 || groundLayer < 0)
            {
                Debug.LogError("[Raceland] Layers missing — run " +
                               "Raceland > Setup > Create Layers, Tags and Collision Matrix first.");
                return;
            }

            var root = new GameObject("Buggy");
            root.transform.SetPositionAndRotation(spawnPosition, spawnRotation);
            root.layer = vehicleLayer;
            root.tag = RacelandLayers.PlayerTag;

            // ---- Body ----------------------------------------------------------------

            GameObject body = (GameObject)PrefabUtility.InstantiatePrefab(chassisModel);
            body.name = "ChassisVisual";
            body.transform.SetParent(root.transform, false);

            // Centre the shell on the root in X/Z and sit its underside on y = 0.
            body.transform.localPosition = new Vector3(
                -chassisBounds.center.x,
                -chassisBounds.min.y,
                -chassisBounds.center.z);

            SetLayerRecursive(body, vehicleLayer);

            var collider = root.AddComponent<BoxCollider>();
            collider.size = new Vector3(bodyWidth, bodyHeight, bodyLength);
            collider.center = new Vector3(0f, bodyHeight * 0.5f, 0f);

            var rigidbody = root.AddComponent<Rigidbody>();
            rigidbody.mass = mass;
            rigidbody.drag = 0.05f;
            rigidbody.angularDrag = 2.5f;

            // ---- Wheels ---------------------------------------------------------------

            var wheelRoot = new GameObject("Wheels");
            wheelRoot.transform.SetParent(root.transform, false);

            var anchors = new Transform[4];
            var pivots = new Transform[4];

            // Order matters: BuggyController's anti-roll bar pairs 0-1 and 2-3.
            (string name, float x, float z)[] corners =
            {
                ("FrontLeft", -anchorX, anchorZ),
                ("FrontRight", anchorX, anchorZ),
                ("RearLeft", -anchorX, -anchorZ),
                ("RearRight", anchorX, -anchorZ)
            };

            for (int i = 0; i < corners.Length; i++)
            {
                (string name, float x, float z) = corners[i];

                var anchor = new GameObject($"Anchor_{name}");
                anchor.transform.SetParent(wheelRoot.transform, false);
                anchor.transform.localPosition = new Vector3(x, anchorY, z);
                anchors[i] = anchor.transform;

                var pivot = new GameObject($"Wheel_{name}");
                pivot.transform.SetParent(wheelRoot.transform, false);
                pivot.transform.localPosition = new Vector3(x, wheelCentreAtRest, z);
                pivots[i] = pivot.transform;

                GameObject mesh = (GameObject)PrefabUtility.InstantiatePrefab(wheelModel);
                mesh.name = "Mesh";
                mesh.transform.SetParent(pivot.transform, false);

                // The pivot correction. Offsetting the mesh by minus its own bounds centre
                // puts the axle exactly on the pivot, so the wheel spins rather than orbits.
                mesh.transform.localPosition = -wheelBounds.center;

                // Mirror the left-hand wheels so any asymmetric detail (rim dish, tread
                // direction) faces outwards on both sides.
                if (x < 0f) mesh.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);

                SetLayerRecursive(mesh, vehicleLayer);
            }

            // ---- Components ------------------------------------------------------------

            BuggyController buggy = root.AddComponent<BuggyController>();

            var serialized = new SerializedObject(buggy);
            SerializedProperty wheelsProperty = serialized.FindProperty("wheels");
            wheelsProperty.arraySize = 4;

            for (int i = 0; i < 4; i++)
            {
                SerializedProperty element = wheelsProperty.GetArrayElementAtIndex(i);
                element.FindPropertyRelative("anchor").objectReferenceValue = anchors[i];
                element.FindPropertyRelative("visual").objectReferenceValue = pivots[i];
                element.FindPropertyRelative("steers").boolValue = i < 2;
                element.FindPropertyRelative("powered").boolValue = true;
                element.FindPropertyRelative("radius").floatValue = wheelRadius;
            }

            int mask = 1 << groundLayer;
            if (obstacleLayer >= 0) mask |= 1 << obstacleLayer;
            serialized.FindProperty("groundMask").intValue = mask;

            serialized.FindProperty("suspensionRestLength").floatValue = restLength;
            serialized.FindProperty("suspensionMaxTravel").floatValue = maxTravel;
            serialized.FindProperty("springStrength").floatValue = springStrength;
            serialized.FindProperty("springDamper").floatValue = springDamper;

            // Centre of mass below the body floor. This is the single value that decides
            // whether the car corners flat or rolls onto its roof.
            serialized.FindProperty("centreOfMassOffset").vector3Value =
                new Vector3(0f, -bodyHeight * 0.35f, -bodyLength * 0.02f);

            serialized.ApplyModifiedPropertiesWithoutUndo();

            root.AddComponent<WheelVisual>();
            root.AddComponent<BoostSystem>();
            root.AddComponent<RespawnController>();

            StuntScorer scorer = root.AddComponent<StuntScorer>();
            if (obstacleLayer >= 0) scorer.SetPrivateLayerMask("nearMissMask", 1 << obstacleLayer);

            var engineSource = root.AddComponent<AudioSource>();
            engineSource.playOnAwake = false;
            engineSource.loop = true;

            var effectSource = root.AddComponent<AudioSource>();
            effectSource.playOnAwake = false;

            VehicleAudio audio = root.AddComponent<VehicleAudio>();
            audio.SetPrivateObject("engineSource", engineSource);
            audio.SetPrivateObject("effectSource", effectSource);

            // DamageableBody is deliberately not added. These chassis are single meshes
            // with no separable panels, so there is nothing to tear off — see the note in
            // Docs/ASSET_PIPELINE.md about what the voxel pack does and doesn't cover.

            // ---- Rebind the scene -------------------------------------------------------

            if (existing != null && replaceExisting)
            {
                DestroyImmediate(existing.gameObject);

                ChaseCamera camera = FindObjectOfType<ChaseCamera>();
                if (camera != null) camera.SetPrivateObject("target", buggy);

                RaceManager race = FindObjectOfType<RaceManager>();
                if (race != null) race.SetPrivateObject("buggy", buggy);
            }

            Selection.activeGameObject = root;
            EditorUtility.SetDirty(root);

            Debug.Log(
                $"[Raceland] Built '{chassisModel.name}' with '{wheelModel.name}'.\n" +
                $"  Body      {bodyWidth:F2} w x {bodyHeight:F2} h x {bodyLength:F2} l m\n" +
                $"  Wheel     radius {wheelRadius:F3} m, width {wheelWidth:F3} m\n" +
                $"  Wheelbase {anchorZ * 2f:F2} m, track {anchorX * 2f:F2} m\n" +
                $"  Spring    {springStrength:N0} N/m, damper {springDamper:N0} " +
                $"(solved for {staticCompression:P0} static compression at {mass:N0} kg)",
                root);
        }

        /// <summary>
        /// Combined local-space bounds of every renderer in a model, measured by briefly
        /// instantiating it. Renderer bounds are world-space, so the instance is placed at
        /// the origin unrotated and torn down immediately afterwards.
        /// </summary>
        private static Bounds MeasureModel(GameObject model, out bool success)
        {
            success = false;
            var bounds = new Bounds();

            GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(model);
            if (instance == null) return bounds;

            instance.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            instance.transform.localScale = Vector3.one;

            Renderer[] renderers = instance.GetComponentsInChildren<Renderer>();

            if (renderers.Length > 0)
            {
                bounds = renderers[0].bounds;
                for (int i = 1; i < renderers.Length; i++) bounds.Encapsulate(renderers[i].bounds);
                success = true;
            }

            DestroyImmediate(instance);
            return bounds;
        }

        private static void SetLayerRecursive(GameObject target, int layer)
        {
            target.layer = layer;
            foreach (Transform child in target.transform) SetLayerRecursive(child.gameObject, layer);
        }
    }
}
