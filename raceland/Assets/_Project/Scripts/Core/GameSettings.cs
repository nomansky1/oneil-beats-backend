using UnityEngine;

namespace Raceland.Core
{
    /// <summary>Which loop the player picked from the main menu.</summary>
    public enum GameMode
    {
        /// <summary>Start line, checkpoints, finish, timer. The MVP default.</summary>
        TimeTrial = 0,

        /// <summary>No finish line — score air time, flips, near misses and wrecks.</summary>
        StuntScore = 1
    }

    /// <summary>
    /// Persisted player choices and records, on top of PlayerPrefs.
    ///
    /// PlayerPrefs is the right call at this size: a handful of scalars, no sync, no
    /// schema. If save data ever grows past this, move it to JSON in persistentDataPath
    /// rather than adding more keys here.
    /// </summary>
    public static class GameSettings
    {
        private const string ModeKey = "raceland.mode";
        private const string AutoAccelerateKey = "raceland.autoAccelerate";
        private const string MasterVolumeKey = "raceland.volume";
        private const string BestTimePrefix = "raceland.bestTime.";
        private const string BestScorePrefix = "raceland.bestScore.";

        public static GameMode Mode
        {
            get => (GameMode)PlayerPrefs.GetInt(ModeKey, (int)GameMode.TimeTrial);
            set
            {
                PlayerPrefs.SetInt(ModeKey, (int)value);
                PlayerPrefs.Save();
            }
        }

        /// <summary>Defaults on — most mobile racers do, and it frees a thumb for steering.</summary>
        public static bool AutoAccelerate
        {
            get => PlayerPrefs.GetInt(AutoAccelerateKey, 1) == 1;
            set
            {
                PlayerPrefs.SetInt(AutoAccelerateKey, value ? 1 : 0);
                PlayerPrefs.Save();
            }
        }

        public static float MasterVolume
        {
            get => PlayerPrefs.GetFloat(MasterVolumeKey, 1f);
            set
            {
                PlayerPrefs.SetFloat(MasterVolumeKey, Mathf.Clamp01(value));
                PlayerPrefs.Save();
            }
        }

        /// <summary>Best lap for a track, in seconds. Returns 0 when there is no record yet.</summary>
        public static float GetBestTime(string trackId)
        {
            return PlayerPrefs.GetFloat(BestTimePrefix + trackId, 0f);
        }

        /// <summary>Store a time if it beats the record. Returns true when it was a new best.</summary>
        public static bool TrySetBestTime(string trackId, float seconds)
        {
            float existing = GetBestTime(trackId);
            if (existing > 0f && seconds >= existing) return false;

            PlayerPrefs.SetFloat(BestTimePrefix + trackId, seconds);
            PlayerPrefs.Save();
            return true;
        }

        public static int GetBestScore(string trackId)
        {
            return PlayerPrefs.GetInt(BestScorePrefix + trackId, 0);
        }

        public static bool TrySetBestScore(string trackId, int score)
        {
            if (score <= GetBestScore(trackId)) return false;

            PlayerPrefs.SetInt(BestScorePrefix + trackId, score);
            PlayerPrefs.Save();
            return true;
        }

        /// <summary>Format seconds as m:ss.mmm for the HUD and results screen.</summary>
        public static string FormatTime(float seconds)
        {
            if (seconds <= 0f) return "--:--.---";

            int minutes = Mathf.FloorToInt(seconds / 60f);
            float remainder = seconds - minutes * 60f;
            return $"{minutes}:{remainder:00.000}";
        }
    }
}
