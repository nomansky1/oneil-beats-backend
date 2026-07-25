using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Creates the layers and tags the game depends on, and sets the collision matrix.
    ///
    /// The collision matrix is the part that actually matters: debris must not collide
    /// with the vehicle. Without that rule, a torn-off body panel bounces straight back
    /// into the buggy, triggers another impact, tears off another panel, and the car
    /// disassembles itself in about a second.
    /// </summary>
    public static class RacelandLayers
    {
        public const string Vehicle = "Vehicle";
        public const string Ground = "Ground";
        public const string Obstacle = "Obstacle";
        public const string Debris = "Debris";
        public const string Trigger = "TrackTrigger";

        public const string PlayerTag = "Player";

        private static readonly string[] RequiredLayers = { Vehicle, Ground, Obstacle, Debris, Trigger };

        [MenuItem("Raceland/Setup/Create Layers, Tags and Collision Matrix", priority = 3)]
        public static void EnsureLayersExist()
        {
            SerializedObject tagManager = new SerializedObject(
                AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset")[0]);

            AddTag(tagManager, PlayerTag);

            foreach (string layer in RequiredLayers)
            {
                AddLayer(tagManager, layer);
            }

            tagManager.ApplyModifiedProperties();
            AssetDatabase.SaveAssets();

            ApplyCollisionMatrix();
        }

        private static void AddTag(SerializedObject tagManager, string tag)
        {
            SerializedProperty tags = tagManager.FindProperty("tags");

            for (int i = 0; i < tags.arraySize; i++)
            {
                if (tags.GetArrayElementAtIndex(i).stringValue == tag)
                {
                    return;
                }
            }

            tags.InsertArrayElementAtIndex(tags.arraySize);
            tags.GetArrayElementAtIndex(tags.arraySize - 1).stringValue = tag;

            Debug.Log($"[Raceland] Added tag '{tag}'.");
        }

        private static void AddLayer(SerializedObject tagManager, string layer)
        {
            SerializedProperty layers = tagManager.FindProperty("layers");

            for (int i = 0; i < layers.arraySize; i++)
            {
                if (layers.GetArrayElementAtIndex(i).stringValue == layer) return;
            }

            // Layers 0-7 are Unity's built-ins and must not be overwritten.
            for (int i = 8; i < layers.arraySize; i++)
            {
                SerializedProperty slot = layers.GetArrayElementAtIndex(i);
                if (!string.IsNullOrEmpty(slot.stringValue)) continue;

                slot.stringValue = layer;
                Debug.Log($"[Raceland] Added layer '{layer}' at index {i}.");
                return;
            }

            Debug.LogError($"[Raceland] No free layer slot for '{layer}'. " +
                           "Clear an unused layer in Project Settings > Tags and Layers.");
        }

        [MenuItem("Raceland/Setup/Apply Collision Matrix Only", priority = 4)]
        public static void ApplyCollisionMatrix()
        {
            int vehicle = LayerMask.NameToLayer(Vehicle);
            int debris = LayerMask.NameToLayer(Debris);
            int ground = LayerMask.NameToLayer(Ground);
            int obstacle = LayerMask.NameToLayer(Obstacle);

            if (vehicle < 0 || debris < 0 || ground < 0 || obstacle < 0)
            {
                Debug.LogError("[Raceland] Layers missing — run " +
                               "'Create Layers, Tags and Collision Matrix' first.");
                return;
            }

            // The rule that stops the buggy shredding itself on its own debris.
            Physics.IgnoreLayerCollision(vehicle, debris, true);

            // Debris settles on the ground but passes through obstacles and other debris,
            // which keeps the physics cost of a big wreck bounded.
            Physics.IgnoreLayerCollision(debris, debris, true);
            Physics.IgnoreLayerCollision(debris, obstacle, true);
            Physics.IgnoreLayerCollision(debris, ground, false);

            Debug.Log("[Raceland] Collision matrix applied: Vehicle ignores Debris; " +
                      "Debris only collides with Ground.\n" +
                      "Verify it stuck in Project Settings > Physics > Layer Collision Matrix — " +
                      "if the checkboxes look unchanged, set them by hand there once and they " +
                      "will persist in DynamicsManager.asset.");
        }
    }
}
