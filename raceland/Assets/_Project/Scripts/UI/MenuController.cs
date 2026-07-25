using Raceland.Core;
using Raceland.Track;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Raceland.UI
{
    /// <summary>
    /// Main menu, pause and results, all driven from one scene.
    ///
    /// Keeping menus in the race scene rather than a separate one avoids a load between
    /// pressing Play and driving, which on a mid-tier phone is the difference between the
    /// game feeling instant and feeling sluggish. The cost is that this class owns
    /// timeScale, so it is the only place allowed to touch it.
    /// </summary>
    public class MenuController : MonoBehaviour
    {
        [Header("Panels")]
        [SerializeField] private GameObject mainMenuPanel;
        [SerializeField] private GameObject hudPanel;
        [SerializeField] private GameObject pausePanel;
        [SerializeField] private GameObject resultsPanel;

        [Header("Main menu")]
        [SerializeField] private Button playButton;
        [SerializeField] private Button modeToggleButton;
        [SerializeField] private TMP_Text modeLabel;
        [SerializeField] private TMP_Text recordLabel;

        [Header("Pause")]
        [SerializeField] private Button pauseButton;
        [SerializeField] private Button resumeButton;
        [SerializeField] private Button restartButton;
        [SerializeField] private Button quitToMenuButton;

        [Header("Results")]
        [SerializeField] private TMP_Text resultsHeadlineLabel;
        [SerializeField] private TMP_Text resultsDetailLabel;
        [SerializeField] private Button resultsRestartButton;
        [SerializeField] private Button resultsMenuButton;

        [Header("Scene")]
        [SerializeField] private RaceManager race;
        [SerializeField] private TouchControls touchControls;

        public bool IsPaused { get; private set; }

        private void Awake()
        {
            if (race == null) race = FindObjectOfType<RaceManager>();
            if (touchControls == null) touchControls = FindObjectOfType<TouchControls>();

            WireButton(playButton, StartRace);
            WireButton(modeToggleButton, ToggleMode);
            WireButton(pauseButton, Pause);
            WireButton(resumeButton, Resume);
            WireButton(restartButton, Restart);
            WireButton(quitToMenuButton, ReturnToMenu);
            WireButton(resultsRestartButton, Restart);
            WireButton(resultsMenuButton, ReturnToMenu);
        }

        private void OnEnable()
        {
            if (race != null) race.RaceFinished += HandleRaceFinished;
        }

        private void OnDisable()
        {
            if (race != null) race.RaceFinished -= HandleRaceFinished;
        }

        private void Start()
        {
            ShowMainMenu();
        }

        private void Update()
        {
            // Android back button. Behaves the way players expect: back out of a menu,
            // or pause if you're driving.
            if (!Input.GetKeyDown(KeyCode.Escape)) return;

            if (resultsPanel != null && resultsPanel.activeSelf) ReturnToMenu();
            else if (IsPaused) Resume();
            else if (mainMenuPanel != null && !mainMenuPanel.activeSelf) Pause();
            else Application.Quit();
        }

        // ---- Main menu -----------------------------------------------------------

        private void ShowMainMenu()
        {
            SetTimeScale(0f);
            IsPaused = false;

            SetPanel(mainMenuPanel, true);
            SetPanel(hudPanel, false);
            SetPanel(pausePanel, false);
            SetPanel(resultsPanel, false);

            if (VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.ClearHeldInput();
                VehicleInputHub.Instance.InputLocked = true;
            }

            RefreshModeLabels();
        }

        private void ToggleMode()
        {
            GameSettings.Mode = GameSettings.Mode == GameMode.TimeTrial
                ? GameMode.StuntScore
                : GameMode.TimeTrial;

            RefreshModeLabels();
        }

        private void RefreshModeLabels()
        {
            GameMode mode = GameSettings.Mode;

            if (modeLabel != null)
            {
                modeLabel.text = mode == GameMode.TimeTrial ? "TIME TRIAL" : "STUNT SCORE";
            }

            if (recordLabel == null || race == null) return;

            if (mode == GameMode.TimeTrial)
            {
                float best = GameSettings.GetBestTime(race.TrackId);
                recordLabel.text = best > 0f
                    ? $"BEST LAP  {GameSettings.FormatTime(best)}"
                    : "NO LAP SET";
            }
            else
            {
                int best = GameSettings.GetBestScore(race.TrackId);
                recordLabel.text = best > 0 ? $"BEST SCORE  {best:N0}" : "NO SCORE SET";
            }
        }

        private void StartRace()
        {
            SetPanel(mainMenuPanel, false);
            SetPanel(resultsPanel, false);
            SetPanel(hudPanel, true);

            SetTimeScale(1f);
            IsPaused = false;

            // RaceManager unlocks input itself once the countdown finishes.
            race?.BeginRun();
        }

        // ---- Pause ---------------------------------------------------------------

        public void Pause()
        {
            if (IsPaused) return;
            if (race == null || race.State == RaceState.Idle) return;

            IsPaused = true;
            SetTimeScale(0f);
            SetPanel(pausePanel, true);

            // Release every held button before hiding the HUD, or the throttle stays
            // latched on through the pause and the buggy takes off on resume.
            touchControls?.ReleaseAll();

            if (VehicleInputHub.Instance != null) VehicleInputHub.Instance.InputLocked = true;
        }

        public void Resume()
        {
            if (!IsPaused) return;

            IsPaused = false;
            SetPanel(pausePanel, false);
            SetTimeScale(1f);

            // Only hand control back if the race is actually live — resuming into a
            // countdown must not unlock input early.
            if (race != null && race.State == RaceState.Running && VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.InputLocked = false;
            }
        }

        public void Restart()
        {
            SetPanel(pausePanel, false);
            SetPanel(resultsPanel, false);
            SetPanel(hudPanel, true);

            IsPaused = false;
            SetTimeScale(1f);

            touchControls?.ReleaseAll();
            race?.BeginRun();
        }

        public void ReturnToMenu()
        {
            touchControls?.ReleaseAll();
            ShowMainMenu();
        }

        // ---- Results -------------------------------------------------------------

        private void HandleRaceFinished(RaceResult result)
        {
            SetPanel(hudPanel, false);
            SetPanel(resultsPanel, true);
            SetTimeScale(0f);

            touchControls?.ReleaseAll();

            if (result.Mode == GameMode.TimeTrial)
            {
                if (resultsHeadlineLabel != null)
                {
                    resultsHeadlineLabel.text = result.IsNewBest ? "NEW BEST LAP" : "FINISHED";
                }

                if (resultsDetailLabel != null)
                {
                    string best = result.BestTime > 0f
                        ? GameSettings.FormatTime(result.BestTime)
                        : "--";

                    resultsDetailLabel.text =
                        $"TIME    {GameSettings.FormatTime(result.Time)}\n" +
                        $"BEST    {best}\n" +
                        $"RESETS  {result.Respawns}\n" +
                        $"STUNTS  {result.Score:N0}";
                }
            }
            else
            {
                if (resultsHeadlineLabel != null)
                {
                    resultsHeadlineLabel.text = result.IsNewBestScore ? "NEW HIGH SCORE" : "TIME UP";
                }

                if (resultsDetailLabel != null)
                {
                    resultsDetailLabel.text =
                        $"SCORE   {result.Score:N0}\n" +
                        $"BEST    {GameSettings.GetBestScore(race.TrackId):N0}\n" +
                        $"RESETS  {result.Respawns}";
                }
            }
        }

        // ---- Helpers -------------------------------------------------------------

        private static void SetPanel(GameObject panel, bool visible)
        {
            if (panel != null) panel.SetActive(visible);
        }

        private static void SetTimeScale(float scale)
        {
            Time.timeScale = scale;

            // Keep the physics step in proportion, otherwise resuming from a pause can
            // land the first frame with a huge accumulated delta and fling the buggy.
            Time.fixedDeltaTime = 0.02f * Mathf.Max(scale, 0.0001f);
        }

        private static void WireButton(Button button, UnityEngine.Events.UnityAction action)
        {
            if (button != null) button.onClick.AddListener(action);
        }

        private void OnDestroy()
        {
            // Leaving timeScale at 0 would freeze whatever loads next.
            SetTimeScale(1f);
        }
    }
}
