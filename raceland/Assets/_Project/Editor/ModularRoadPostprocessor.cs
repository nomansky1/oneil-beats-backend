using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Import settings for the Atomic Realm Modular Roads kit.
    ///
    /// Applies to anything under a folder named "ModularRoads". Unlike the voxel pack,
    /// this kit needs almost no correction — it is already authored the way a Unity kit
    /// should be:
    ///
    /// - **1 unit = 1 metre.** A road tile is 12 x 12 m, kerb 0.48 m tall, a parking
    ///   meter 1.41 m. No scale factor.
    /// - **Pivots centred in X/Z with the base at Y = 0.** Tiles snap on a 12 m grid by
    ///   position alone, which is what makes the track builder possible.
    /// - **Featherweight.** 44-664 tris per module, median 46.
    ///
    /// So the job here is mostly to not break it: keep the scale at 1, generate colliders
    /// (the suspension raycasts against these, so they need real geometry), and keep the
    /// textures at a sane mobile size.
    /// </summary>
    public class ModularRoadPostprocessor : AssetPostprocessor
    {
        private const string FolderMarker = "/ModularRoads/";

        /// <summary>Tile pitch in metres. The whole kit is authored to this grid.</summary>
        public const float GridSize = 12f;

        private bool IsRoadAsset => assetPath.Contains(FolderMarker);

        private void OnPreprocessModel()
        {
            if (!IsRoadAsset) return;

            var importer = (ModelImporter)assetImporter;

            // Already metric — anything other than 1 breaks the grid.
            importer.globalScale = 1f;
            importer.useFileScale = false;

            // Smooth-shaded with a hard crease on kerbs and edges. 60 degrees keeps the
            // road surface smooth while leaving the kerb corners sharp.
            importer.importNormals = ModelImporterNormals.Calculate;
            importer.normalSmoothingAngle = 60f;

            importer.importCameras = false;
            importer.importLights = false;
            importer.importAnimation = false;
            importer.importVisibility = false;

            // Roads are what the buggy drives on, so they need collision. At a median of
            // 46 triangles a mesh collider is cheaper here than the box approximations
            // would be inaccurate — a box would flatten every kerb and camber.
            importer.addCollider = true;

            importer.meshCompression = ModelImporterMeshCompression.Medium;
            importer.optimizeMeshPolygons = true;
            importer.optimizeMeshVertices = true;
            importer.weldVertices = true;
            importer.isReadable = false;

            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            importer.materialLocation = ModelImporterMaterialLocation.External;
        }

        private void OnPreprocessTexture()
        {
            if (!IsRoadAsset) return;

            var importer = (TextureImporter)assetImporter;

            // The kit ships 1024s, which is the top of the brief's budget. Kept rather
            // than shrunk: road surface is most of what fills the screen, and this is the
            // one place the extra resolution is visible.
            importer.maxTextureSize = 1024;
            importer.mipmapEnabled = true;
            importer.streamingMipmaps = true;
            importer.filterMode = FilterMode.Bilinear;
            importer.textureCompression = TextureImporterCompression.Compressed;
            importer.wrapMode = TextureWrapMode.Repeat;

            var androidSettings = new TextureImporterPlatformSettings
            {
                name = "Android",
                overridden = true,
                maxTextureSize = 1024,
                format = TextureImporterFormat.ASTC_6x6,
                compressionQuality = 50
            };

            importer.SetPlatformTextureSettings(androidSettings);
        }

        private void OnPostprocessModel(GameObject model)
        {
            if (!IsRoadAsset) return;

            int groundLayer = LayerMask.NameToLayer(RacelandLayers.Ground);
            if (groundLayer >= 0) SetLayerRecursive(model, groundLayer);

            // Static: the track never moves, and batching it is the difference between a
            // few draw calls and several hundred on a phone.
            GameObjectUtility.SetStaticEditorFlags(model,
                StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccluderStatic |
                StaticEditorFlags.OccludeeStatic);
        }

        private static void SetLayerRecursive(GameObject target, int layer)
        {
            target.layer = layer;
            foreach (Transform child in target.transform) SetLayerRecursive(child.gameObject, layer);
        }
    }
}
