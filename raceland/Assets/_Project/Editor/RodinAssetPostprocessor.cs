using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Import settings applied automatically to Rodin exports.
    ///
    /// This exists because of the scale problem the brief calls out. Rodin and Blender
    /// exports arrive at inconsistent scales and orientations, and the resulting
    /// misalignment is exactly the headache that cost time on the previous project.
    /// Fixing it per-asset by hand does not scale and does not survive a reimport;
    /// enforcing it at import time does.
    ///
    /// Anything under a folder named "Rodin" is treated as a raw generated asset.
    /// </summary>
    public class RodinAssetPostprocessor : AssetPostprocessor
    {
        private const string RodinFolderMarker = "/Rodin/";

        private bool IsRodinAsset => assetPath.Contains(RodinFolderMarker);

        private void OnPreprocessModel()
        {
            if (!IsRodinAsset) return;

            var importer = (ModelImporter)assetImporter;

            // One unit standard: 1 Unity unit = 1 metre, scale locked at import so a mesh
            // that arrives in centimetres doesn't end up 100x too big in the scene.
            importer.globalScale = 1f;
            importer.useFileScale = false;

            importer.bakeAxisConversion = true;
            importer.importCameras = false;
            importer.importLights = false;
            importer.importVisibility = false;

            // Bang Parts splits must survive: merging would collapse the panels and
            // obstacle halves into one mesh and break both damage systems.
            importer.importAnimation = false;
            importer.preserveHierarchy = true;

            importer.meshCompression = ModelImporterMeshCompression.Medium;
            importer.optimizeMeshPolygons = true;
            importer.optimizeMeshVertices = true;
            importer.weldVertices = true;

            // Read/write off saves a duplicate copy of every mesh in memory. Nothing here
            // reads mesh data at runtime.
            importer.isReadable = false;

            // Colliders come from hand-placed primitives, not generated per-mesh — a mesh
            // collider on a detailed buggy would be both slow and badly behaved.
            importer.addCollider = false;

            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            importer.materialLocation = ModelImporterMaterialLocation.External;
        }

        private void OnPreprocessTexture()
        {
            if (!IsRodinAsset) return;

            var importer = (TextureImporter)assetImporter;

            // Brief's budget: 512-1024 max. Rodin exports 2K/4K by default, which would
            // blow the texture memory budget on a mid-tier phone several times over.
            importer.maxTextureSize = 1024;
            importer.mipmapEnabled = true;
            importer.streamingMipmaps = true;

            importer.textureCompression = TextureImporterCompression.Compressed;

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
            if (!IsRodinAsset) return;

            int triangles = 0;

            foreach (MeshFilter filter in model.GetComponentsInChildren<MeshFilter>())
            {
                if (filter.sharedMesh != null) triangles += filter.sharedMesh.triangles.Length / 3;
            }

            // Warn rather than fail: the raw Rodin export is expected to be over budget,
            // and gets retopologised in Blender. This is here so an un-retopologised mesh
            // can't quietly reach the phone.
            if (triangles > 8000)
            {
                Debug.LogWarning(
                    $"[Raceland] '{assetPath}' is {triangles:N0} triangles — over the brief's " +
                    "budget (buggy 3k-8k, props 200-1500). Retopologise in Blender before " +
                    "using this in the scene.", model);
            }
        }
    }
}
