using UnityEditor;
using UnityEngine;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Import settings for voxel asset packs (VoxEdit / MagicaVoxel OBJ exports).
    ///
    /// Applies to anything under a folder named "Voxel". Voxel art needs almost the
    /// opposite import settings to conventional PBR meshes, and every one of the defaults
    /// Unity picks is wrong for it:
    ///
    /// - The textures are tiny palettes where one pixel is a whole car panel. Bilinear
    ///   filtering blends neighbouring palette entries, so a red car picks up a smear of
    ///   whatever colour sits next to red in the strip. Compression does the same thing
    ///   permanently. Both have to be off.
    /// - Voxel meshes want hard, faceted shading. Unity's default smoothing angle rounds
    ///   the lighting across voxel corners and the blocky look goes soft and waxy.
    /// - VoxEdit exports in voxel units, so a car arrives ~215 units long instead of ~4 m.
    /// </summary>
    public class VoxelAssetPostprocessor : AssetPostprocessor
    {
        private const string VoxelFolderMarker = "/Voxel/";

        /// <summary>
        /// 1 voxel = 2 cm. Derived from the pack itself: the chassis is 215 voxels long,
        /// and 215 x 0.02 = 4.3 m, which is a real car. The wheels agree — 35 voxels
        /// across gives a 0.70 m tyre. Change this and the physics rig needs re-tuning,
        /// because wheel radius feeds both the suspension cast and the ride height.
        /// </summary>
        public const float VoxelToMetres = 0.02f;

        private bool IsVoxelAsset => assetPath.Contains(VoxelFolderMarker);

        private void OnPreprocessModel()
        {
            if (!IsVoxelAsset) return;

            var importer = (ModelImporter)assetImporter;

            importer.globalScale = VoxelToMetres;
            importer.useFileScale = false;

            // Hard-edged shading. A smoothing angle of 0 means no normals are averaged
            // across an edge, so every voxel face lights independently and the blocky
            // silhouette reads properly.
            importer.importNormals = ModelImporterNormals.Calculate;
            importer.normalSmoothingAngle = 0f;

            importer.importCameras = false;
            importer.importLights = false;
            importer.importAnimation = false;
            importer.importVisibility = false;

            // Colliders are hand-placed primitives. A mesh collider on a voxel car would
            // be thousands of triangles of collision geometry for no gameplay benefit.
            importer.addCollider = false;

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
            if (!IsVoxelAsset) return;

            var importer = (TextureImporter)assetImporter;

            // The three settings that make or break voxel art.
            importer.filterMode = FilterMode.Point;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.mipmapEnabled = false;

            // Clamp, not repeat: a palette strip that wraps samples the far end of the
            // palette at the edges and produces stray colours along panel seams.
            importer.wrapMode = TextureWrapMode.Clamp;

            // These are already 256x256 or smaller. Uncompressed is affordable precisely
            // because they are tiny — a 256x256 RGBA32 palette is 256 KB.
            importer.maxTextureSize = 512;
            importer.npotScale = TextureImporterNPOTScale.None;

            var androidSettings = new TextureImporterPlatformSettings
            {
                name = "Android",
                overridden = true,
                maxTextureSize = 512,
                format = TextureImporterFormat.RGBA32,
                textureCompression = TextureImporterCompression.Uncompressed
            };

            importer.SetPlatformTextureSettings(androidSettings);
        }

        private void OnPostprocessModel(GameObject model)
        {
            if (!IsVoxelAsset) return;

            int triangles = 0;
            Bounds bounds = new Bounds();
            bool boundsInitialised = false;

            foreach (MeshFilter filter in model.GetComponentsInChildren<MeshFilter>())
            {
                if (filter.sharedMesh == null) continue;

                triangles += filter.sharedMesh.triangles.Length / 3;

                if (!boundsInitialised)
                {
                    bounds = filter.sharedMesh.bounds;
                    boundsInitialised = true;
                }
                else
                {
                    bounds.Encapsulate(filter.sharedMesh.bounds);
                }
            }

            if (!boundsInitialised) return;

            Vector3 size = bounds.size;

            // Logged rather than enforced: the numbers are the fastest way to spot an
            // asset that came in at the wrong scale, which is otherwise only obvious once
            // it's in a scene next to something else.
            Debug.Log($"[Raceland] Voxel import '{System.IO.Path.GetFileName(assetPath)}': " +
                      $"{triangles:N0} tris, {size.x:F2} x {size.y:F2} x {size.z:F2} m.", model);

            if (triangles > 8000)
            {
                Debug.LogWarning(
                    $"[Raceland] '{assetPath}' is {triangles:N0} triangles, over the brief's " +
                    "budget (vehicle 3k-8k, props 200-1500).", model);
            }
        }
    }
}
