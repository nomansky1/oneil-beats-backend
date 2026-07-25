using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Helpers for writing to <c>[SerializeField] private</c> fields from editor tooling.
    ///
    /// The gameplay scripts keep their fields private on purpose — they're inspector
    /// configuration, not public API. Rather than widening them to public just so a
    /// builder script can reach them, the builder goes through SerializedObject, which
    /// is the supported path and also marks the scene dirty correctly.
    /// </summary>
    public static class EditorObjectExtensions
    {
        public static void SetPrivateObject(this Object target, string fieldName, Object value)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.objectReferenceValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        public static void SetPrivateFloat(this Object target, string fieldName, float value)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.floatValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        public static void SetPrivateInt(this Object target, string fieldName, int value)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.intValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        public static void SetPrivateBool(this Object target, string fieldName, bool value)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.boolValue = value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        public static void SetPrivateLayerMask(this Object target, string fieldName, LayerMask value)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.intValue = value.value;
            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>Assign an array of object references to a private serialized array field.</summary>
        public static void SetPrivateObjectArray(this Object target, string fieldName, Object[] values)
        {
            var serialized = new SerializedObject(target);
            SerializedProperty property = Require(serialized, fieldName, target);
            if (property == null) return;

            property.arraySize = values.Length;

            for (int i = 0; i < values.Length; i++)
            {
                property.GetArrayElementAtIndex(i).objectReferenceValue = values[i];
            }

            serialized.ApplyModifiedPropertiesWithoutUndo();
        }

        /// <summary>
        /// Get a serialized array element's sub-property, for arrays of serializable
        /// classes such as the buggy's wheel list.
        /// </summary>
        public static SerializedObject BeginEdit(this Object target) => new SerializedObject(target);

        private static SerializedProperty Require(SerializedObject serialized, string fieldName, Object target)
        {
            SerializedProperty property = serialized.FindProperty(fieldName);

            if (property == null)
            {
                // A renamed field would otherwise fail silently and leave a half-built
                // scene that looks fine until you press play.
                Debug.LogError($"[Raceland] Field '{fieldName}' not found on " +
                               $"{target.GetType().Name}. The scene builder is out of sync " +
                               "with the script — update the field name in the builder.");
            }

            return property;
        }
    }
}
