using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Raceland.Core;
using Raceland.Vehicle;
using UnityEngine;

namespace Raceland.Track
{
    public enum RaceState
    {
        Idle,
        Countdown,
        Running,
        Finished
    }

    /// <summary>Everything the results screen needs about a completed run.</summary>
    public struct RaceResult
    {
        public float Time;
        public float BestTime;
        public bool IsNewBest;
        public int Respawns;
        public int Score;
        public bool IsNewBestScore;
        public GameMode Mode;
    }

    /// <summary>
    /// Runs the round: countdown, timer, checkpoint sequencing, lap counting, and the
    /// results handoff.
    ///
    /// Handles both modes from the brief. Time trial is the default and drives the
    /// checkpoint/finish logic; stunt score reuses the same track and physics events but
    /// never ends on its own — it runs to a time limit instead.
    /// </summary>
    public class RaceManager : MonoBehaviour
    {
        [Header("Track")]
        [Tooltip("Identifier used for the saved best time and best score. Change this when " +
                 "the track layout changes materially, or old records become meaningless.")]
        [SerializeField] private string trackId = "wasteland-01";

        [SerializeField] private FinishLine finishLine;

        [Tooltip("Left empty, every Checkpoint in the scene is collected and sorted by index.")]
        [SerializeField] private Checkpoint[] checkpoints;

        [Tooltip("Laps needed to finish a time trial.")]
        [Min(1)]
        [SerializeField] private int lapsToFinish = 1;

        [Header("Player")]
        [SerializeField] private BuggyController buggy;

        [Header("Countdown")]
        [Tooltip("Seconds of locked input before the timer starts.")]
        [SerializeField] private float countdownSeconds = 3f;

        [Tooltip("Start the countdown as soon as the scene loads. Turn this off when a main " +
                 "menu is in the scene — MenuController calls BeginRun when Play is pressed.")]
        [SerializeField] private bool autoStart = true;

        [Header("Stunt mode")]
        [Tooltip("Round length in seconds when playing stunt score. Ignored in time trial.")]
        [SerializeField] private float stuntRoundSeconds = 120f;

        private RespawnController respawn;
        private StuntScorer scorer;
        private readonly HashSet<int> takenCheckpoints = new HashSet<int>();
        private float elapsed;
        private int currentLap;

        public RaceState State { get; private set; } = RaceState.Idle;

        /// <summary>Run time in seconds, frozen once the round ends.</summary>
        public float Elapsed => elapsed;

        /// <summary>Counts down in stunt mode; counts up in time trial.</summary>
        public float DisplayTime => Mode == GameMode.StuntScore
            ? Mathf.Max(0f, stuntRoundSeconds - elapsed)
            : elapsed;

        public GameMode Mode { get; private set; }

        public int CheckpointsTaken => takenCheckpoints.Count;
        public int CheckpointsTotal => checkpoints?.Length ?? 0;
        public int CurrentLap => currentLap + 1;
        public int TotalLaps => lapsToFinish;
        public string TrackId => trackId;

        public event Action<RaceState> StateChanged;

        /// <summary>Fires with (secondsRemaining) each countdown tick, then 0 for "GO".</summary>
        public event Action<int> CountdownTick;

        public event Action<int, int> CheckpointProgress;
        public event Action<int, int> LapChanged;
        public event Action<RaceResult> RaceFinished;

        private void Awake()
        {
            Mode = GameSettings.Mode;

            if (checkpoints == null || checkpoints.Length == 0)
            {
                checkpoints = FindObjectsOfType<Checkpoint>();
            }

            // Sort explicitly: FindObjectsOfType returns scene order, which has nothing to
            // do with the racing line, and unordered checkpoints silently break lap validation.
            checkpoints = checkpoints.OrderBy(c => c.Index).ToArray();

            if (buggy == null) buggy = FindObjectOfType<BuggyController>();
            if (buggy != null)
            {
                respawn = buggy.GetComponent<RespawnController>();
                scorer = buggy.GetComponent<StuntScorer>();
            }
        }

        private void OnEnable()
        {
            foreach (Checkpoint checkpoint in checkpoints)
            {
                if (checkpoint != null) checkpoint.Passed += HandleCheckpointPassed;
            }

            if (finishLine != null) finishLine.Crossed += HandleFinishCrossed;
        }

        private void OnDisable()
        {
            foreach (Checkpoint checkpoint in checkpoints)
            {
                if (checkpoint != null) checkpoint.Passed -= HandleCheckpointPassed;
            }

            if (finishLine != null) finishLine.Crossed -= HandleFinishCrossed;
        }

        private void Start()
        {
            if (autoStart) BeginRun();
        }

        private void Update()
        {
            if (State != RaceState.Running) return;

            elapsed += Time.deltaTime;

            if (Mode == GameMode.StuntScore && elapsed >= stuntRoundSeconds)
            {
                Finish();
            }
        }

        /// <summary>Reset to the grid and start the countdown. Also used by the restart button.</summary>
        public void BeginRun()
        {
            Mode = GameSettings.Mode;

            elapsed = 0f;
            currentLap = 0;
            takenCheckpoints.Clear();

            foreach (Checkpoint checkpoint in checkpoints)
            {
                if (checkpoint != null) checkpoint.SetArmed(true);
            }

            // Grid placement goes through RespawnController so it picks up the same
            // vertical offset a checkpoint respawn uses. Placing the buggy directly at the
            // grid anchor puts its origin on the track centreline, which is below the road
            // surface — the buggy starts embedded in the road.
            if (respawn != null)
            {
                if (finishLine != null)
                {
                    respawn.SetRespawnPoint(finishLine.GridPosition, finishLine.GridRotation);
                }

                respawn.ResetForNewRun();
                respawn.PlaceAtRespawnPoint();
            }
            else if (buggy != null && finishLine != null)
            {
                // No respawn controller (a bare physics-tuning scene). Lift it clear of the
                // surface so it still lands on its wheels.
                buggy.Teleport(finishLine.GridPosition + Vector3.up * 1.5f, finishLine.GridRotation);
            }

            if (scorer != null) scorer.ResetScore();

            CheckpointProgress?.Invoke(0, CheckpointsTotal);
            LapChanged?.Invoke(CurrentLap, TotalLaps);

            StopAllCoroutines();
            StartCoroutine(CountdownThenGo());
        }

        private IEnumerator CountdownThenGo()
        {
            SetState(RaceState.Countdown);

            if (VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.ClearHeldInput();
                VehicleInputHub.Instance.InputLocked = true;
            }

            int remaining = Mathf.CeilToInt(countdownSeconds);
            while (remaining > 0)
            {
                CountdownTick?.Invoke(remaining);
                yield return new WaitForSeconds(1f);
                remaining--;
            }

            CountdownTick?.Invoke(0); // "GO"

            if (VehicleInputHub.Instance != null) VehicleInputHub.Instance.InputLocked = false;

            SetState(RaceState.Running);
        }

        private void HandleCheckpointPassed(Checkpoint checkpoint)
        {
            if (State != RaceState.Running) return;

            // Always move the respawn anchor, even on a checkpoint that's already been
            // taken this lap — being sent backwards after a crash is worse than a
            // slightly generous respawn.
            if (respawn != null)
            {
                respawn.SetRespawnPoint(checkpoint.RespawnPosition, checkpoint.RespawnRotation);
            }

            if (!takenCheckpoints.Add(checkpoint.Index)) return;

            checkpoint.SetArmed(false);
            CheckpointProgress?.Invoke(takenCheckpoints.Count, CheckpointsTotal);
        }

        private void HandleFinishCrossed()
        {
            if (State != RaceState.Running) return;

            // Stunt mode has no finish — the round is on a clock.
            if (Mode == GameMode.StuntScore) return;

            // Partial lap: the player cut the course, so the crossing doesn't count.
            if (takenCheckpoints.Count < CheckpointsTotal) return;

            currentLap++;

            if (currentLap >= lapsToFinish)
            {
                Finish();
                return;
            }

            takenCheckpoints.Clear();

            foreach (Checkpoint checkpoint in checkpoints)
            {
                if (checkpoint != null) checkpoint.SetArmed(true);
            }

            CheckpointProgress?.Invoke(0, CheckpointsTotal);
            LapChanged?.Invoke(CurrentLap, TotalLaps);
        }

        private void Finish()
        {
            SetState(RaceState.Finished);

            if (VehicleInputHub.Instance != null)
            {
                VehicleInputHub.Instance.ClearHeldInput();
                VehicleInputHub.Instance.InputLocked = true;
            }

            int score = scorer != null ? scorer.Score : 0;

            var result = new RaceResult
            {
                Time = elapsed,
                Respawns = respawn != null ? respawn.RespawnCount : 0,
                Score = score,
                Mode = Mode
            };

            if (Mode == GameMode.TimeTrial)
            {
                result.IsNewBest = GameSettings.TrySetBestTime(trackId, elapsed);
                result.BestTime = GameSettings.GetBestTime(trackId);
            }
            else
            {
                result.IsNewBestScore = GameSettings.TrySetBestScore(trackId, score);
            }

            RaceFinished?.Invoke(result);
        }

        private void SetState(RaceState state)
        {
            if (State == state) return;

            State = state;
            StateChanged?.Invoke(state);
        }
    }
}
