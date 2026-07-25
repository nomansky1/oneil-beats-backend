using System.Collections;
using Raceland.Core;
using Raceland.Gameplay;
using Raceland.Track;
using Raceland.Vehicle;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Raceland.UI
{
    /// <summary>
    /// The in-race HUD: speed, boost meter, timer, lap/checkpoint progress, score popups
    /// and the countdown.
    ///
    /// Every field is optional so the HUD prefab can be built up piece by piece without
    /// null-referencing the whole scene. Values that change every frame are only written
    /// to their labels when they actually change — string allocation per frame is a real
    /// cost on a phone, and the speed readout is the worst offender.
    /// </summary>
    public class HudController : MonoBehaviour
    {
        [Header("Sources")]
        [SerializeField] private BuggyController buggy;
        [SerializeField] private RaceManager race;

        [Header("Speed")]
        [SerializeField] private TMP_Text speedLabel;
        [SerializeField] private string speedFormat = "{0}";
        [SerializeField] private TMP_Text speedUnitLabel;

        [Header("Boost")]
        [Tooltip("Image with Type = Filled. Fill amount tracks the boost meter.")]
        [SerializeField] private Image boostFill;

        [SerializeField] private Color boostReadyColour = new Color(1f, 0.62f, 0.15f);
        [SerializeField] private Color boostLowColour = new Color(0.55f, 0.25f, 0.15f);

        [Header("Timer")]
        [SerializeField] private TMP_Text timerLabel;
        [SerializeField] private TMP_Text bestTimeLabel;

        [Header("Progress")]
        [SerializeField] private TMP_Text lapLabel;
        [SerializeField] private TMP_Text checkpointLabel;

        [Header("Score")]
        [SerializeField] private GameObject scoreRoot;
        [SerializeField] private TMP_Text scoreLabel;
        [SerializeField] private TMP_Text comboLabel;

        [Tooltip("Popup shown when points bank. Fades itself out.")]
        [SerializeField] private TMP_Text scorePopupLabel;

        [SerializeField] private float popupDuration = 1.1f;

        [Header("Countdown")]
        [SerializeField] private TMP_Text countdownLabel;
        [SerializeField] private string goText = "GO!";

        private BoostSystem boost;
        private StuntScorer scorer;

        private int lastShownSpeed = -1;
        private string lastShownTime;
        private int lastShownScore = -1;
        private Coroutine popupRoutine;

        private void Awake()
        {
            if (buggy == null) buggy = FindObjectOfType<BuggyController>();
            if (race == null) race = FindObjectOfType<RaceManager>();

            if (buggy != null)
            {
                boost = buggy.GetComponent<BoostSystem>();
                scorer = buggy.GetComponent<StuntScorer>();
            }

            if (countdownLabel != null) countdownLabel.gameObject.SetActive(false);
            if (scorePopupLabel != null) scorePopupLabel.gameObject.SetActive(false);
        }

        private void OnEnable()
        {
            if (race != null)
            {
                race.CountdownTick += HandleCountdownTick;
                race.CheckpointProgress += HandleCheckpointProgress;
                race.LapChanged += HandleLapChanged;
            }

            if (scorer != null)
            {
                scorer.Scored += HandleScored;
                scorer.TrickLost += HandleTrickLost;
            }

            // Refreshed on every enable rather than in Start: the HUD is hidden while the
            // main menu is up, and the player can change mode there. Start would only ever
            // run once, leaving the lap counter showing during a stunt run.
            RefreshForMode();
        }

        private void OnDisable()
        {
            if (race != null)
            {
                race.CountdownTick -= HandleCountdownTick;
                race.CheckpointProgress -= HandleCheckpointProgress;
                race.LapChanged -= HandleLapChanged;
            }

            if (scorer != null)
            {
                scorer.Scored -= HandleScored;
                scorer.TrickLost -= HandleTrickLost;
            }
        }

        private void RefreshForMode()
        {
            // Read the saved setting rather than race.Mode: the HUD is switched on just
            // before RaceManager.BeginRun picks the mode up, so race.Mode is still the
            // previous run's value at this point.
            bool stuntMode = GameSettings.Mode == GameMode.StuntScore;

            // Clear the "only write the label when the value changed" caches, or the first
            // frame of a new run keeps the previous run's text.
            lastShownSpeed = -1;
            lastShownTime = null;
            lastShownScore = -1;

            if (scoreRoot != null) scoreRoot.SetActive(true);
            if (lapLabel != null) lapLabel.gameObject.SetActive(!stuntMode);
            if (checkpointLabel != null) checkpointLabel.gameObject.SetActive(!stuntMode);

            if (bestTimeLabel != null && race != null)
            {
                if (stuntMode)
                {
                    int best = GameSettings.GetBestScore(race.TrackId);
                    bestTimeLabel.text = best > 0 ? $"BEST {best:N0}" : "NO RECORD";
                }
                else
                {
                    float best = GameSettings.GetBestTime(race.TrackId);
                    bestTimeLabel.text = best > 0f ? $"BEST {GameSettings.FormatTime(best)}" : "NO RECORD";
                }
            }

            if (speedUnitLabel != null) speedUnitLabel.text = "KM/H";
        }

        private void Update()
        {
            UpdateSpeed();
            UpdateBoost();
            UpdateTimer();
            UpdateScore();
        }

        private void UpdateSpeed()
        {
            if (speedLabel == null || buggy == null) return;

            int speed = Mathf.RoundToInt(buggy.SpeedKph);
            if (speed == lastShownSpeed) return;

            lastShownSpeed = speed;
            speedLabel.text = string.Format(speedFormat, speed);
        }

        private void UpdateBoost()
        {
            if (boostFill == null || boost == null) return;

            float charge = boost.NormalizedCharge;
            boostFill.fillAmount = charge;
            boostFill.color = Color.Lerp(boostLowColour, boostReadyColour, charge);
        }

        private void UpdateTimer()
        {
            if (timerLabel == null || race == null) return;

            string formatted = GameSettings.FormatTime(race.DisplayTime);
            if (formatted == lastShownTime) return;

            lastShownTime = formatted;
            timerLabel.text = formatted;
        }

        private void UpdateScore()
        {
            if (scorer == null) return;

            if (scoreLabel != null && scorer.Score != lastShownScore)
            {
                lastShownScore = scorer.Score;
                scoreLabel.text = scorer.Score.ToString("N0");
            }

            if (comboLabel != null)
            {
                bool showCombo = scorer.ComboMultiplier > 1.01f;
                comboLabel.gameObject.SetActive(showCombo);
                if (showCombo) comboLabel.text = $"x{scorer.ComboMultiplier:0.0}";
            }
        }

        private void HandleCountdownTick(int secondsRemaining)
        {
            if (countdownLabel == null) return;

            countdownLabel.gameObject.SetActive(true);
            countdownLabel.text = secondsRemaining > 0 ? secondsRemaining.ToString() : goText;

            if (secondsRemaining == 0)
            {
                // Hide "GO!" shortly after the race starts. Realtime, so it still clears
                // if the player pauses the instant the race begins.
                StartCoroutine(HideCountdownAfter(0.75f));
            }
        }

        private IEnumerator HideCountdownAfter(float seconds)
        {
            yield return new WaitForSecondsRealtime(seconds);
            if (countdownLabel != null) countdownLabel.gameObject.SetActive(false);
        }

        private void HandleCheckpointProgress(int taken, int total)
        {
            if (checkpointLabel == null) return;
            checkpointLabel.text = $"CP {taken}/{total}";
        }

        private void HandleLapChanged(int lap, int total)
        {
            if (lapLabel == null) return;
            lapLabel.text = total > 1 ? $"LAP {lap}/{total}" : "LAP 1";
        }

        private void HandleScored(int points, string label)
        {
            ShowPopup($"{label}  +{points:N0}", new Color(1f, 0.85f, 0.4f));
        }

        private void HandleTrickLost(int lostPoints)
        {
            if (lostPoints <= 0) return;
            ShowPopup($"CRASHED  -{lostPoints:N0}", new Color(1f, 0.4f, 0.35f));
        }

        private void ShowPopup(string message, Color colour)
        {
            if (scorePopupLabel == null) return;

            if (popupRoutine != null) StopCoroutine(popupRoutine);
            popupRoutine = StartCoroutine(PopupRoutine(message, colour));
        }

        private IEnumerator PopupRoutine(string message, Color colour)
        {
            scorePopupLabel.gameObject.SetActive(true);
            scorePopupLabel.text = message;

            float elapsed = 0f;
            while (elapsed < popupDuration)
            {
                elapsed += Time.deltaTime;

                float t = elapsed / popupDuration;
                Color faded = colour;
                faded.a = 1f - t * t; // Hold, then fall away quickly.
                scorePopupLabel.color = faded;

                yield return null;
            }

            scorePopupLabel.gameObject.SetActive(false);
            popupRoutine = null;
        }
    }
}
