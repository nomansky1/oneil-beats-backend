using Raceland.UI;
using Raceland.Vehicle;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Raceland.EditorTools
{
    /// <summary>
    /// Builds the whole canvas: touch controls, HUD, main menu, pause and results.
    ///
    /// Laid out for landscape with both thumbs on the screen — steering bottom-left,
    /// throttle and boost bottom-right, information along the top where a hand isn't
    /// covering it. The control sizes are deliberately large: 200px at a 1920-wide
    /// reference resolution is roughly a fingertip on a real phone, and anything smaller
    /// gets missed at speed.
    /// </summary>
    public static class RacelandUIBuilder
    {
        private static readonly Color PanelBackground = new Color(0.08f, 0.06f, 0.05f, 0.85f);
        private static readonly Color ButtonColour = new Color(0.55f, 0.3f, 0.15f, 0.75f);
        private static readonly Color AccentColour = new Color(1f, 0.62f, 0.15f);
        private static readonly Color TextColour = new Color(0.96f, 0.92f, 0.85f);

        [MenuItem("Raceland/Rebuild UI In Current Scene", priority = 41)]
        public static void RebuildUIMenuItem()
        {
            BuggyController buggy = Object.FindObjectOfType<BuggyController>();

            if (buggy == null)
            {
                Debug.LogError("[Raceland] No buggy in the scene — build the track first.");
                return;
            }

            var existing = Object.FindObjectOfType<MenuController>();
            if (existing != null) Object.DestroyImmediate(existing.gameObject);

            BuildUI(buggy);
        }

        public static void BuildUI(BuggyController buggy)
        {
            if (TMP_Settings.defaultFontAsset == null)
            {
                Debug.LogWarning(
                    "[Raceland] TextMeshPro essentials are not imported, so every label will " +
                    "be blank. Fix: Window > TextMeshPro > Import TMP Essential Resources, " +
                    "then run Raceland > Rebuild UI In Current Scene.");
            }

            EnsureEventSystem();

            GameObject canvasObject = CreateCanvas();
            RectTransform canvas = canvasObject.GetComponent<RectTransform>();

            GameObject hudPanel = CreatePanel(canvas, "HUD", Color.clear);
            GameObject mainMenuPanel = CreatePanel(canvas, "MainMenu", PanelBackground);
            GameObject pausePanel = CreatePanel(canvas, "Pause", PanelBackground);
            GameObject resultsPanel = CreatePanel(canvas, "Results", PanelBackground);

            HudController hud = BuildHud(hudPanel, out Button pauseButton, out TouchControls touchControls);
            BuildMainMenu(mainMenuPanel, out Button playButton, out Button modeButton,
                out TMP_Text modeLabel, out TMP_Text recordLabel);
            BuildPause(pausePanel, out Button resumeButton, out Button restartButton, out Button quitButton);
            BuildResults(resultsPanel, out TMP_Text headline, out TMP_Text detail,
                out Button resultsRestart, out Button resultsMenu);

            var menuObject = new GameObject("MenuController");
            MenuController menu = menuObject.AddComponent<MenuController>();

            menu.SetPrivateObject("mainMenuPanel", mainMenuPanel);
            menu.SetPrivateObject("hudPanel", hudPanel);
            menu.SetPrivateObject("pausePanel", pausePanel);
            menu.SetPrivateObject("resultsPanel", resultsPanel);
            menu.SetPrivateObject("playButton", playButton);
            menu.SetPrivateObject("modeToggleButton", modeButton);
            menu.SetPrivateObject("modeLabel", modeLabel);
            menu.SetPrivateObject("recordLabel", recordLabel);
            menu.SetPrivateObject("pauseButton", pauseButton);
            menu.SetPrivateObject("resumeButton", resumeButton);
            menu.SetPrivateObject("restartButton", restartButton);
            menu.SetPrivateObject("quitToMenuButton", quitButton);
            menu.SetPrivateObject("resultsHeadlineLabel", headline);
            menu.SetPrivateObject("resultsDetailLabel", detail);
            menu.SetPrivateObject("resultsRestartButton", resultsRestart);
            menu.SetPrivateObject("resultsMenuButton", resultsMenu);
            menu.SetPrivateObject("touchControls", touchControls);

            hud.SetPrivateObject("buggy", buggy);

            Debug.Log("[Raceland] UI built: HUD, touch controls, main menu, pause, results.");
        }

        // ---- Scaffolding -----------------------------------------------------------

        private static void EnsureEventSystem()
        {
            if (Object.FindObjectOfType<EventSystem>() != null) return;

            var eventSystem = new GameObject("EventSystem");
            eventSystem.AddComponent<EventSystem>();
            eventSystem.AddComponent<StandaloneInputModule>();
        }

        private static GameObject CreateCanvas()
        {
            var canvasObject = new GameObject("UICanvas");

            Canvas canvas = canvasObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;

            var scaler = canvasObject.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);

            // Match width and height equally so the layout survives the range of phone
            // aspect ratios without controls sliding off the edge.
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;

            canvasObject.AddComponent<GraphicRaycaster>();

            return canvasObject;
        }

        private static GameObject CreatePanel(RectTransform parent, string name, Color background)
        {
            var panel = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            RectTransform rect = panel.GetComponent<RectTransform>();
            rect.SetParent(parent, false);

            Stretch(rect);

            Image image = panel.GetComponent<Image>();
            image.color = background;

            // A fully transparent backdrop must not swallow touches meant for the controls
            // underneath it.
            image.raycastTarget = background.a > 0.01f;

            return panel;
        }

        // ---- HUD -------------------------------------------------------------------

        private static HudController BuildHud(GameObject hudPanel, out Button pauseButton,
            out TouchControls touchControls)
        {
            RectTransform hud = hudPanel.GetComponent<RectTransform>();

            TMP_Text speed = CreateText(hud, "Speed", "0", 96, TextAnchor.UpperLeft);
            Anchor(speed.rectTransform, new Vector2(0f, 1f), new Vector2(40f, -40f), new Vector2(340f, 110f));
            speed.alignment = TextAlignmentOptions.Left;

            TMP_Text speedUnit = CreateText(hud, "SpeedUnit", "KM/H", 32, TextAnchor.UpperLeft);
            Anchor(speedUnit.rectTransform, new Vector2(0f, 1f), new Vector2(44f, -150f), new Vector2(240f, 44f));
            speedUnit.alignment = TextAlignmentOptions.Left;
            speedUnit.color = AccentColour;

            TMP_Text timer = CreateText(hud, "Timer", "0:00.000", 68, TextAnchor.UpperCenter);
            Anchor(timer.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -40f), new Vector2(520f, 84f));

            TMP_Text best = CreateText(hud, "BestTime", "NO RECORD", 30, TextAnchor.UpperCenter);
            Anchor(best.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -128f), new Vector2(520f, 40f));
            best.color = AccentColour;

            TMP_Text lap = CreateText(hud, "Lap", "LAP 1", 34, TextAnchor.UpperRight);
            Anchor(lap.rectTransform, new Vector2(1f, 1f), new Vector2(-220f, -40f), new Vector2(240f, 44f));
            lap.alignment = TextAlignmentOptions.Right;

            TMP_Text checkpoint = CreateText(hud, "Checkpoints", "CP 0/4", 34, TextAnchor.UpperRight);
            Anchor(checkpoint.rectTransform, new Vector2(1f, 1f), new Vector2(-220f, -90f), new Vector2(240f, 44f));
            checkpoint.alignment = TextAlignmentOptions.Right;

            var scoreRoot = new GameObject("ScoreRoot", typeof(RectTransform));
            RectTransform scoreRect = scoreRoot.GetComponent<RectTransform>();
            scoreRect.SetParent(hud, false);
            Anchor(scoreRect, new Vector2(1f, 1f), new Vector2(-220f, -150f), new Vector2(280f, 100f));

            TMP_Text score = CreateText(scoreRect, "Score", "0", 46, TextAnchor.UpperRight);
            Anchor(score.rectTransform, new Vector2(1f, 1f), new Vector2(0f, 0f), new Vector2(280f, 56f));
            score.alignment = TextAlignmentOptions.Right;

            TMP_Text combo = CreateText(scoreRect, "Combo", "x1.0", 32, TextAnchor.UpperRight);
            Anchor(combo.rectTransform, new Vector2(1f, 1f), new Vector2(0f, -56f), new Vector2(280f, 40f));
            combo.alignment = TextAlignmentOptions.Right;
            combo.color = AccentColour;

            TMP_Text popup = CreateText(hud, "ScorePopup", "", 54, TextAnchor.MiddleCenter);
            Anchor(popup.rectTransform, new Vector2(0.5f, 0.5f), new Vector2(0f, 180f), new Vector2(900f, 80f));

            TMP_Text countdown = CreateText(hud, "Countdown", "3", 200, TextAnchor.MiddleCenter);
            Anchor(countdown.rectTransform, new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(600f, 260f));
            countdown.color = AccentColour;

            Image boostFill = CreateBoostMeter(hud);

            pauseButton = CreateButton(hud, "PauseButton", "II", 44);
            Anchor(pauseButton.GetComponent<RectTransform>(), new Vector2(1f, 1f),
                new Vector2(-70f, -70f), new Vector2(96f, 96f));

            touchControls = BuildTouchControls(hud);

            HudController hudController = hudPanel.AddComponent<HudController>();
            hudController.SetPrivateObject("speedLabel", speed);
            hudController.SetPrivateObject("speedUnitLabel", speedUnit);
            hudController.SetPrivateObject("boostFill", boostFill);
            hudController.SetPrivateObject("timerLabel", timer);
            hudController.SetPrivateObject("bestTimeLabel", best);
            hudController.SetPrivateObject("lapLabel", lap);
            hudController.SetPrivateObject("checkpointLabel", checkpoint);
            hudController.SetPrivateObject("scoreRoot", scoreRoot);
            hudController.SetPrivateObject("scoreLabel", score);
            hudController.SetPrivateObject("comboLabel", combo);
            hudController.SetPrivateObject("scorePopupLabel", popup);
            hudController.SetPrivateObject("countdownLabel", countdown);

            return hudController;
        }

        private static Image CreateBoostMeter(RectTransform parent)
        {
            var background = new GameObject("BoostMeterBackground",
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            RectTransform backgroundRect = background.GetComponent<RectTransform>();
            backgroundRect.SetParent(parent, false);
            Anchor(backgroundRect, new Vector2(0f, 1f), new Vector2(44f, -210f), new Vector2(320f, 28f));
            background.GetComponent<Image>().color = new Color(0.1f, 0.08f, 0.06f, 0.8f);

            var fill = new GameObject("BoostMeterFill",
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            RectTransform fillRect = fill.GetComponent<RectTransform>();
            fillRect.SetParent(backgroundRect, false);
            Stretch(fillRect);

            Image fillImage = fill.GetComponent<Image>();
            fillImage.color = AccentColour;

            // Filled/horizontal so HudController can drive it with fillAmount.
            fillImage.type = Image.Type.Filled;
            fillImage.fillMethod = Image.FillMethod.Horizontal;
            fillImage.fillOrigin = (int)Image.OriginHorizontal.Left;
            fillImage.fillAmount = 1f;

            return fillImage;
        }

        private static TouchControls BuildTouchControls(RectTransform hud)
        {
            var root = new GameObject("TouchControls", typeof(RectTransform));
            RectTransform rect = root.GetComponent<RectTransform>();
            rect.SetParent(hud, false);
            Stretch(rect);

            // Left thumb: steering.
            HoldButton left = CreateHoldButton(rect, "SteerLeft", "<", new Vector2(0f, 0f),
                new Vector2(140f, 140f), new Vector2(200f, 200f));
            HoldButton right = CreateHoldButton(rect, "SteerRight", ">", new Vector2(0f, 0f),
                new Vector2(370f, 140f), new Vector2(200f, 200f));

            // Right thumb: throttle, boost, and the secondary controls above them.
            HoldButton accelerate = CreateHoldButton(rect, "Accelerate", "GO", new Vector2(1f, 0f),
                new Vector2(-140f, 140f), new Vector2(210f, 210f));
            HoldButton boost = CreateHoldButton(rect, "Boost", "BOOST", new Vector2(1f, 0f),
                new Vector2(-370f, 130f), new Vector2(170f, 170f));
            HoldButton brake = CreateHoldButton(rect, "Brake", "BRAKE", new Vector2(1f, 0f),
                new Vector2(-140f, 380f), new Vector2(170f, 130f));
            HoldButton reverse = CreateHoldButton(rect, "Reverse", "REV", new Vector2(1f, 0f),
                new Vector2(-330f, 350f), new Vector2(140f, 110f));

            Button respawn = CreateButton(rect, "RespawnButton", "RESET", 30);
            Anchor(respawn.GetComponent<RectTransform>(), new Vector2(0f, 0f),
                new Vector2(140f, 330f), new Vector2(180f, 90f));

            Toggle autoAccelerate = CreateToggle(rect, "AutoAccelerateToggle", "AUTO");
            Anchor(autoAccelerate.GetComponent<RectTransform>(), new Vector2(0f, 1f),
                new Vector2(150f, -280f), new Vector2(260f, 60f));

            TouchControls controls = root.AddComponent<TouchControls>();
            controls.SetPrivateObject("steerLeft", left);
            controls.SetPrivateObject("steerRight", right);
            controls.SetPrivateObject("accelerate", accelerate);
            controls.SetPrivateObject("reverse", reverse);
            controls.SetPrivateObject("brake", brake);
            controls.SetPrivateObject("boost", boost);
            controls.SetPrivateObject("respawnButton", respawn);
            controls.SetPrivateObject("autoAccelerateToggle", autoAccelerate);
            controls.SetPrivateObject("accelerateButtonRoot", accelerate.gameObject);

            return controls;
        }

        // ---- Menus -----------------------------------------------------------------

        private static void BuildMainMenu(GameObject panel, out Button play, out Button modeToggle,
            out TMP_Text modeLabel, out TMP_Text recordLabel)
        {
            RectTransform rect = panel.GetComponent<RectTransform>();

            TMP_Text title = CreateText(rect, "Title", "RACELAND", 150, TextAnchor.MiddleCenter);
            Anchor(title.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -160f), new Vector2(1200f, 180f));
            title.color = AccentColour;

            TMP_Text subtitle = CreateText(rect, "Subtitle", "WASTELAND CIRCUIT 01", 40, TextAnchor.MiddleCenter);
            Anchor(subtitle.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -300f), new Vector2(1200f, 60f));

            play = CreateButton(rect, "PlayButton", "DRIVE", 60);
            Anchor(play.GetComponent<RectTransform>(), new Vector2(0.5f, 0.5f),
                new Vector2(0f, 20f), new Vector2(460f, 130f));

            modeToggle = CreateButton(rect, "ModeButton", "", 44);
            Anchor(modeToggle.GetComponent<RectTransform>(), new Vector2(0.5f, 0.5f),
                new Vector2(0f, -130f), new Vector2(460f, 100f));
            modeLabel = modeToggle.GetComponentInChildren<TMP_Text>();
            modeLabel.text = "TIME TRIAL";

            recordLabel = CreateText(rect, "RecordLabel", "NO LAP SET", 36, TextAnchor.MiddleCenter);
            Anchor(recordLabel.rectTransform, new Vector2(0.5f, 0.5f),
                new Vector2(0f, -240f), new Vector2(700f, 60f));
            recordLabel.color = AccentColour;

            TMP_Text hint = CreateText(rect, "Hint",
                "TAP THE MODE BUTTON TO SWITCH BETWEEN TIME TRIAL AND STUNT SCORE",
                26, TextAnchor.LowerCenter);
            Anchor(hint.rectTransform, new Vector2(0.5f, 0f), new Vector2(0f, 70f), new Vector2(1400f, 50f));
        }

        private static void BuildPause(GameObject panel, out Button resume, out Button restart, out Button quit)
        {
            RectTransform rect = panel.GetComponent<RectTransform>();

            TMP_Text title = CreateText(rect, "Title", "PAUSED", 110, TextAnchor.MiddleCenter);
            Anchor(title.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -200f), new Vector2(900f, 140f));
            title.color = AccentColour;

            resume = CreateButton(rect, "ResumeButton", "RESUME", 52);
            Anchor(resume.GetComponent<RectTransform>(), new Vector2(0.5f, 0.5f),
                new Vector2(0f, 60f), new Vector2(440f, 110f));

            restart = CreateButton(rect, "RestartButton", "RESTART", 52);
            Anchor(restart.GetComponent<RectTransform>(), new Vector2(0.5f, 0.5f),
                new Vector2(0f, -70f), new Vector2(440f, 110f));

            quit = CreateButton(rect, "QuitButton", "MAIN MENU", 52);
            Anchor(quit.GetComponent<RectTransform>(), new Vector2(0.5f, 0.5f),
                new Vector2(0f, -200f), new Vector2(440f, 110f));
        }

        private static void BuildResults(GameObject panel, out TMP_Text headline, out TMP_Text detail,
            out Button restart, out Button menu)
        {
            RectTransform rect = panel.GetComponent<RectTransform>();

            headline = CreateText(rect, "Headline", "FINISHED", 110, TextAnchor.MiddleCenter);
            Anchor(headline.rectTransform, new Vector2(0.5f, 1f), new Vector2(0f, -170f), new Vector2(1200f, 140f));
            headline.color = AccentColour;

            detail = CreateText(rect, "Detail", "", 46, TextAnchor.MiddleCenter);
            Anchor(detail.rectTransform, new Vector2(0.5f, 0.5f), new Vector2(0f, 40f), new Vector2(900f, 320f));

            restart = CreateButton(rect, "ResultsRestartButton", "RUN IT AGAIN", 48);
            Anchor(restart.GetComponent<RectTransform>(), new Vector2(0.5f, 0f),
                new Vector2(-250f, 150f), new Vector2(460f, 110f));

            menu = CreateButton(rect, "ResultsMenuButton", "MAIN MENU", 48);
            Anchor(menu.GetComponent<RectTransform>(), new Vector2(0.5f, 0f),
                new Vector2(250f, 150f), new Vector2(460f, 110f));
        }

        // ---- Widget helpers ---------------------------------------------------------

        private static TMP_Text CreateText(RectTransform parent, string name, string content,
            float fontSize, TextAnchor anchor)
        {
            var textObject = new GameObject(name, typeof(RectTransform));
            RectTransform rect = textObject.GetComponent<RectTransform>();
            rect.SetParent(parent, false);

            var text = textObject.AddComponent<TextMeshProUGUI>();
            text.text = content;
            text.fontSize = fontSize;
            text.color = TextColour;
            text.alignment = ToTmpAlignment(anchor);
            text.enableWordWrapping = true;

            // Labels never need to receive touches, and leaving them as raycast targets is
            // the classic reason a button "doesn't work" — an invisible label is on top.
            text.raycastTarget = false;

            return text;
        }

        private static Button CreateButton(RectTransform parent, string name, string label, float fontSize)
        {
            var buttonObject = new GameObject(name,
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image), typeof(Button));

            RectTransform rect = buttonObject.GetComponent<RectTransform>();
            rect.SetParent(parent, false);

            Image image = buttonObject.GetComponent<Image>();
            image.color = ButtonColour;

            var button = buttonObject.GetComponent<Button>();
            button.targetGraphic = image;

            TMP_Text text = CreateText(rect, "Label", label, fontSize, TextAnchor.MiddleCenter);
            Stretch(text.rectTransform);

            return button;
        }

        private static HoldButton CreateHoldButton(RectTransform parent, string name, string label,
            Vector2 anchor, Vector2 position, Vector2 size)
        {
            var buttonObject = new GameObject(name,
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));

            RectTransform rect = buttonObject.GetComponent<RectTransform>();
            rect.SetParent(parent, false);
            Anchor(rect, anchor, position, size);

            Image image = buttonObject.GetComponent<Image>();
            image.color = ButtonColour;

            TMP_Text text = CreateText(rect, "Label", label, 40, TextAnchor.MiddleCenter);
            Stretch(text.rectTransform);

            return buttonObject.AddComponent<HoldButton>();
        }

        private static Toggle CreateToggle(RectTransform parent, string name, string label)
        {
            var toggleObject = new GameObject(name,
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image), typeof(Toggle));

            RectTransform rect = toggleObject.GetComponent<RectTransform>();
            rect.SetParent(parent, false);

            Image background = toggleObject.GetComponent<Image>();
            background.color = new Color(0.15f, 0.12f, 0.1f, 0.8f);

            var checkmarkObject = new GameObject("Checkmark",
                typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            RectTransform checkmarkRect = checkmarkObject.GetComponent<RectTransform>();
            checkmarkRect.SetParent(rect, false);
            Anchor(checkmarkRect, new Vector2(0f, 0.5f), new Vector2(34f, 0f), new Vector2(40f, 40f));
            checkmarkObject.GetComponent<Image>().color = AccentColour;

            TMP_Text text = CreateText(rect, "Label", label, 30, TextAnchor.MiddleRight);
            Anchor(text.rectTransform, new Vector2(1f, 0.5f), new Vector2(-70f, 0f), new Vector2(150f, 50f));
            text.alignment = TextAlignmentOptions.Right;

            var toggle = toggleObject.GetComponent<Toggle>();
            toggle.targetGraphic = background;
            toggle.graphic = checkmarkObject.GetComponent<Image>();
            toggle.isOn = true;

            return toggle;
        }

        private static TextAlignmentOptions ToTmpAlignment(TextAnchor anchor)
        {
            switch (anchor)
            {
                case TextAnchor.UpperLeft: return TextAlignmentOptions.TopLeft;
                case TextAnchor.UpperCenter: return TextAlignmentOptions.Top;
                case TextAnchor.UpperRight: return TextAlignmentOptions.TopRight;
                case TextAnchor.MiddleLeft: return TextAlignmentOptions.Left;
                case TextAnchor.MiddleRight: return TextAlignmentOptions.Right;
                case TextAnchor.LowerLeft: return TextAlignmentOptions.BottomLeft;
                case TextAnchor.LowerCenter: return TextAlignmentOptions.Bottom;
                case TextAnchor.LowerRight: return TextAlignmentOptions.BottomRight;
                default: return TextAlignmentOptions.Center;
            }
        }

        private static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        private static void Anchor(RectTransform rect, Vector2 anchor, Vector2 position, Vector2 size)
        {
            rect.anchorMin = anchor;
            rect.anchorMax = anchor;
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = position;
            rect.sizeDelta = size;
        }
    }
}
