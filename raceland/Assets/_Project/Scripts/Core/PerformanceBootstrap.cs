using UnityEngine;

namespace Raceland.Core
{
    /// <summary>
    /// Runtime performance settings that can't be baked into project settings.
    ///
    /// The important one is <c>Application.targetFrameRate</c>. On Android, Unity defaults
    /// to 30 fps regardless of what the display can do, so a game that would happily run
    /// at 60 gets capped at half that unless this is set explicitly. The brief targets 60,
    /// so this has to run.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class PerformanceBootstrap : MonoBehaviour
    {
        [Tooltip("Frame rate to request. 60 is the brief's target; the hard floor is 30.")]
        [SerializeField] private int targetFrameRate = 60;

        [Tooltip("Keep the screen awake while driving — no touch input during a long " +
                 "straight would otherwise let the phone dim.")]
        [SerializeField] private bool preventScreenDimming = true;

        [Tooltip("Survive a scene reload. Leave on if scenes are ever added.")]
        [SerializeField] private bool persistAcrossScenes = true;

        private void Awake()
        {
            if (persistAcrossScenes) DontDestroyOnLoad(gameObject);

            // vSync must be off for targetFrameRate to be honoured at all — with vSync on,
            // targetFrameRate is ignored entirely.
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = targetFrameRate;

            if (preventScreenDimming) Screen.sleepTimeout = SleepTimeout.NeverSleep;

            // Landscape both ways, matching the player settings. Setting it here as well
            // covers the case where the app is launched while the phone is held upside down.
            Screen.autorotateToLandscapeLeft = true;
            Screen.autorotateToLandscapeRight = true;
            Screen.autorotateToPortrait = false;
            Screen.autorotateToPortraitUpsideDown = false;
            Screen.orientation = ScreenOrientation.AutoRotation;
        }
    }
}
