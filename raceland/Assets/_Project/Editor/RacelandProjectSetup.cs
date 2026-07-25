using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Raceland.EditorTools
{
    /// <summary>
    /// One-click application of the build configuration from the brief: Android, IL2CPP,
    /// ARM64, landscape, linear colour, mobile-appropriate graphics APIs.
    ///
    /// These all live in ProjectSettings.asset, which is a large generated YAML file that
    /// is painful to review in a diff and easy to corrupt by hand. Setting them through
    /// the PlayerSettings API instead means the configuration is readable, reviewable,
    /// and re-appliable if the settings file is ever lost or reset.
    /// </summary>
    public static class RacelandProjectSetup
    {
        private const string PackageName = "com.nelson.raceland";
        private const string ProductName = "Raceland";
        private const string CompanyName = "Nelson";

        // Android 8.0. Covers effectively every phone still receiving apps, and is high
        // enough to avoid the legacy-API workarounds that older floors drag in.
        private const AndroidSdkVersions MinimumSdk = AndroidSdkVersions.AndroidApiLevel26;

        [MenuItem("Raceland/Setup/Apply Android Build Settings", priority = 0)]
        public static void ApplyAndroidSettings()
        {
            PlayerSettings.companyName = CompanyName;
            PlayerSettings.productName = ProductName;
            PlayerSettings.SetApplicationIdentifier(BuildTargetGroup.Android, PackageName);

            // IL2CPP + ARM64 is not optional: Play Store and modern devices both require a
            // 64-bit binary, and Mono doesn't produce one.
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;

            PlayerSettings.Android.minSdkVersion = MinimumSdk;
            PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;

            // Landscape only, both ways round so the phone can be held either way.
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.AutoRotation;
            PlayerSettings.allowedAutorotateToPortrait = false;
            PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
            PlayerSettings.allowedAutorotateToLandscapeLeft = true;
            PlayerSettings.allowedAutorotateToLandscapeRight = true;

            // Linear colour space — the lighting model the wasteland materials are authored
            // against. Gamma would wash the whole palette out.
            PlayerSettings.colorSpace = ColorSpace.Linear;

            // Vulkan first with a GLES3 fallback for older mid-tier hardware.
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[]
            {
                GraphicsDeviceType.Vulkan,
                GraphicsDeviceType.OpenGLES3
            });

            PlayerSettings.MTRendering = true;
            PlayerSettings.gpuSkinning = true;
            PlayerSettings.stripEngineCode = true;
            PlayerSettings.Android.optimizedFramePacing = true;

            // APK, not AAB — the brief wants something sideloadable.
            EditorUserBuildSettings.buildAppBundle = false;
            EditorUserBuildSettings.androidBuildSubtarget = MobileTextureSubtarget.ASTC;

            AssetDatabase.SaveAssets();

            Debug.Log($"[Raceland] Android settings applied: {PackageName}, IL2CPP/ARM64, " +
                      $"min SDK {MinimumSdk}, landscape, linear colour.");
        }

        [MenuItem("Raceland/Setup/Apply Physics + Time Settings", priority = 1)]
        public static void ApplyPhysicsSettings()
        {
            // 50 Hz physics. The buggy is tuned against this step — changing it changes
            // how the suspension and grip feel, so it belongs in version control, not in
            // whatever the project template happened to ship with.
            Time.fixedDeltaTime = 0.02f;
            Time.maximumDeltaTime = 0.1f;

            Physics.defaultSolverIterations = 8;
            Physics.defaultSolverVelocityIterations = 2;
            Physics.gravity = new Vector3(0f, -18f, 0f);

            Debug.Log("[Raceland] Physics set: 50 Hz step, gravity -18 (heavier than real " +
                      "gravity so jumps land snappily instead of floating).");
        }

        [MenuItem("Raceland/Setup/Validate Render Pipeline", priority = 2)]
        public static void ValidateRenderPipeline()
        {
            RenderPipelineAsset pipeline = GraphicsSettings.defaultRenderPipeline;

            if (pipeline == null)
            {
                Debug.LogError(
                    "[Raceland] No render pipeline assigned — the project is on Built-in.\n" +
                    "Fix: Assets > Create > Rendering > URP Asset (with Universal Renderer), " +
                    "then assign it in Project Settings > Graphics > Scriptable Render Pipeline " +
                    "Settings AND in Project Settings > Quality for every quality level.\n" +
                    "HDRP is not an option here — it will not run on a phone.");
                return;
            }

            if (!pipeline.GetType().Name.Contains("Universal"))
            {
                Debug.LogError($"[Raceland] Render pipeline is '{pipeline.GetType().Name}', " +
                               "expected a Universal (URP) asset. The brief locks this to URP.");
                return;
            }

            Debug.Log($"[Raceland] URP is active: {pipeline.name}.");
        }

        [MenuItem("Raceland/Setup/Apply Everything", priority = 20)]
        public static void ApplyEverything()
        {
            ApplyAndroidSettings();
            ApplyPhysicsSettings();
            ValidateRenderPipeline();
            RacelandLayers.EnsureLayersExist();
        }

        [MenuItem("Raceland/Setup/Switch Build Target To Android", priority = 21)]
        public static void SwitchToAndroid()
        {
            if (EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android)
            {
                Debug.Log("[Raceland] Already on Android.");
                return;
            }

            Debug.Log("[Raceland] Switching build target to Android — this reimports every " +
                      "asset and can take a while on first run.");

            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
        }
    }
}
