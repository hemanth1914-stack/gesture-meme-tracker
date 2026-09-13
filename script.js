/**
 * ====================================================================
 * Gesture Meme Tracker - script.js
 * 
 * Tracks 7 distinct hand gestures in real time using Google MediaPipe Hands:
 * 1. "pointing"   👉 Brahmanandam pointing meme (1 hand, index straight)
 * 2. "explosion"  🤯 Depression / headache meme (2 hands beside head, open)
 * 3. "shrug"      🤷 Ravi Kishan "money follows" meme (2 open palms at chest)
 * 4. "namaste"    🙏 Akshay Kumar namaste meme (2 palms pressed together)
 * 5. "okboth"     👌 Sushant Singh Rajput double OK meme (2 OK hands)
 * 6. "earcup"     👂 Narendra Modi shy ear-scratch meme (1 hand cupped at ear)
 * 7. "salute"     🫡 Varun Dhawan army salute meme (1 flat hand at temple)
 * ====================================================================
 */

// ====================================================================
// 1. GESTURE TO MEME LOOKUP TABLE
// ====================================================================
// To add an 8th gesture later:
// 1) Add the gesture name and image path to this object:
//    e.g. peace: "images/peace.png"
// 2) Add its landmark detection rules inside detectSingleHandGesture() or detectTwoHandGesture()
// ====================================================================
const GESTURE_MEMES = {
    pointing:  "images/bhramanandham.gif",
    explosion: "images/despression.jpeg",
    shrug:     "images/money-follows-my-brotha-ravi-kishan.gif",
    namaste:   "images/namaste.jpg",
    okboth:    "images/ok.jpeg",
    earcup:    "images/shy.jpeg",
    salute:    "images/vd.jpg"
};

// Preload all meme images/GIFs into browser memory for instant display
function preloadMemes() {
    Object.values(GESTURE_MEMES).forEach(src => {
        const img = new Image();
        img.src = src;
    });
}
preloadMemes();

// ====================================================================
// 2. DOM REFERENCES
// ====================================================================
const videoElement = document.getElementById("webcam");
const canvasElement = document.getElementById("output-canvas");
const canvasCtx = canvasElement.getContext("2d");

const loadingOverlay = document.getElementById("loading-overlay");
const statusText = document.getElementById("status-text");

// Meme Overlay Elements
const memeOverlay = document.getElementById("meme-overlay");
const memeImage = document.getElementById("meme-image");
const memeBadge = document.getElementById("meme-badge");

// Debug HUD Elements
const debugActiveGesture = document.getElementById("debug-active-gesture");
const debugRawGesture = document.getElementById("debug-raw-gesture");
const debugStability = document.getElementById("debug-stability");
const debugHandsCount = document.getElementById("debug-hands-count");
const debugFps = document.getElementById("debug-fps");
const toggleDebugBtn = document.getElementById("toggle-debug-btn");
const debugBody = document.getElementById("debug-body");
const gesturePills = document.querySelectorAll(".gesture-pill");

// Collapsible Debug HUD
toggleDebugBtn.addEventListener("click", () => {
    debugBody.classList.toggle("collapsed");
    toggleDebugBtn.textContent = debugBody.classList.contains("collapsed") ? "▲" : "▼";
});

// ====================================================================
// 3. STABILITY & ANTI-FLICKER ENGINE
// ====================================================================
// - STABILITY_THRESHOLD: Must hold a gesture for 4 consecutive frames (~130ms)
//   before showing/switching the meme.
// - DROP_THRESHOLD: Waits 5 consecutive empty frames before hiding the meme,
//   preventing flicker if webcam drops 1 frame.
const STABILITY_THRESHOLD = 4;
const DROP_THRESHOLD = 5;

let currentActiveGesture = null; // Currently visible meme gesture
let candidateGesture = null;     // Gesture being evaluated
let candidateStreak = 0;         // Consecutive frames candidate was detected
let emptyStreak = 0;             // Consecutive frames with no recognized gesture

// FPS tracking
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 0;

// ====================================================================
// 4. GEOMETRIC LANDMARK MATH HELPERS
// ====================================================================

/**
 * 3D Euclidean distance between two landmarks:
 * dist = sqrt((x2 - x1)^2 + (y2 - y1)^2 + (z2 - z1)^2)
 */
function getDistance(p1, p2) {
    if (!p1 || !p2) return 999;
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = (p1.z || 0) - (p2.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Check if a finger (Index, Middle, Ring, Pinky) is extended straight.
 * A finger is open when its tip is farther from the wrist than its PIP joint.
 */
function isFingerExtended(landmarks, tipIdx, pipIdx) {
    const wrist = landmarks[0];
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    return getDistance(tip, wrist) > getDistance(pip, wrist);
}

/**
 * Check if the Thumb is extended away from palm
 */
function isThumbExtended(landmarks) {
    const wrist = landmarks[0];
    const thumbTip = landmarks[4];
    const thumbMcp = landmarks[2];
    const pinkyMcp = landmarks[17];

    const distTipToPinky = getDistance(thumbTip, pinkyMcp);
    const distMcpToPinky = getDistance(thumbMcp, pinkyMcp);
    const distTipToWrist = getDistance(thumbTip, wrist);
    const distMcpToWrist = getDistance(thumbMcp, wrist);

    return distTipToPinky > distMcpToPinky && distTipToWrist > distMcpToWrist;
}

/**
 * Check if hand is forming an OK sign (Thumb tip 4 & Index tip 8 touching)
 */
function isOkSign(landmarks) {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const pinchDist = getDistance(thumbTip, indexTip);

    // Pinch distance is small (< 0.095), and at least one other finger is open
    const middleOpen = isFingerExtended(landmarks, 12, 10);
    const ringOpen = isFingerExtended(landmarks, 16, 14);

    return pinchDist < 0.095 && (middleOpen || ringOpen);
}

/**
 * Count how many of the 5 fingers are currently open/extended
 */
function getOpenFingerCount(landmarks) {
    const thumb = isThumbExtended(landmarks);
    const index = isFingerExtended(landmarks, 8, 6);
    const middle = isFingerExtended(landmarks, 12, 10);
    const ring = isFingerExtended(landmarks, 16, 14);
    const pinky = isFingerExtended(landmarks, 20, 18);
    return [thumb, index, middle, ring, pinky].filter(Boolean).length;
}

// ====================================================================
// 5. GESTURE DETECTION ALGORITHMS
// ====================================================================

/**
 * Classify gestures when TWO hands are detected
 */
function detectTwoHandGesture(hands) {
    const [h1, h2] = hands;

    // 1. "okboth" — Both hands form an OK sign
    if (isOkSign(h1) && isOkSign(h2)) {
        return "okboth";
    }

    const wrist1 = h1[0];
    const wrist2 = h2[0];
    const midTip1 = h1[12];
    const midTip2 = h2[12];

    const wristDistance = getDistance(wrist1, wrist2);
    const tipsDistance = getDistance(midTip1, midTip2);

    // 2. "namaste" — Both palms pressed together in front of chest
    // Wrists and fingertips close together, fingers pointing upwards
    const handsPointingUp = (midTip1.y < wrist1.y) && (midTip2.y < wrist2.y);
    if (wristDistance < 0.25 && tipsDistance < 0.25 && handsPointingUp) {
        return "namaste";
    }

    const openCount1 = getOpenFingerCount(h1);
    const openCount2 = getOpenFingerCount(h2);
    const horizontalDistance = Math.abs(wrist1.x - wrist2.x);

    // 3. "explosion" — Mind blown pose: Both hands raised high beside head, fingers wide open
    const handsRaisedHigh = (wrist1.y < 0.50 && wrist2.y < 0.50) || (midTip1.y < 0.40 && midTip2.y < 0.40);
    if (handsRaisedHigh && horizontalDistance > 0.32 && openCount1 >= 4 && openCount2 >= 4) {
        return "explosion";
    }

    // 4. "shrug" — Both palms open at shoulder/chest level, separated apart
    const handsAtChest = (wrist1.y >= 0.35 && wrist1.y <= 0.90) && (wrist2.y >= 0.35 && wrist2.y <= 0.90);
    if (handsAtChest && horizontalDistance > 0.25 && openCount1 >= 3 && openCount2 >= 3) {
        return "shrug";
    }

    return null;
}

/**
 * Classify gestures when ONE hand is detected
 */
function detectSingleHandGesture(hand) {
    const indexOpen = isFingerExtended(hand, 8, 6);
    const middleOpen = isFingerExtended(hand, 12, 10);
    const ringOpen = isFingerExtended(hand, 16, 14);
    const pinkyOpen = isFingerExtended(hand, 20, 18);
    const openCount = getOpenFingerCount(hand);

    const wrist = hand[0];
    const midTip = hand[12];

    // 1. "pointing" — ONLY Index finger extended straight, other 3 fingers curled tight
    if (indexOpen && !middleOpen && !ringOpen && !pinkyOpen) {
        return "pointing";
    }

    // 2. "salute" — Flat hand (Index, Middle, Ring straight together) raised high at temple
    const handAtTemple = (wrist.y < 0.45 && midTip.y < 0.38);
    const handIsFlat = indexOpen && middleOpen && ringOpen;
    if (handAtTemple && handIsFlat) {
        return "salute";
    }

    // 3. "earcup" — Hand raised to the outer side of the head (near ear), fingers cupped
    const handNearEarX = (wrist.x < 0.35 || wrist.x > 0.65);
    const handNearEarY = (wrist.y < 0.55 && midTip.y < 0.50);
    const isCupped = (openCount >= 1 && openCount <= 4 && !(indexOpen && middleOpen && ringOpen && pinkyOpen));
    if (handNearEarX && handNearEarY && isCupped) {
        return "earcup";
    }

    return null;
}

/**
 * Master classifier: determines if current frame contains any of the 7 gestures
 */
function classifyGestures(multiHandLandmarks) {
    if (!multiHandLandmarks || multiHandLandmarks.length === 0) {
        return null;
    }

    // Check 2-hand gestures first when both hands are visible
    if (multiHandLandmarks.length >= 2) {
        const twoHandGesture = detectTwoHandGesture(multiHandLandmarks);
        if (twoHandGesture) return twoHandGesture;
    }

    // Check single-hand gestures on primary hand
    return detectSingleHandGesture(multiHandLandmarks[0]);
}

// ====================================================================
// 6. STABILITY BUFFER & MEME OVERLAY CONTROLLER
// ====================================================================

function processGestureStability(rawGesture) {
    if (rawGesture) {
        emptyStreak = 0;

        if (rawGesture === candidateGesture) {
            candidateStreak++;
        } else {
            // Started a new gesture candidate
            candidateGesture = rawGesture;
            candidateStreak = 1;
        }

        // Activate meme once held for required consecutive frames
        if (candidateStreak >= STABILITY_THRESHOLD) {
            setActiveMemeGesture(candidateGesture);
        }
    } else {
        // No gesture detected in this frame
        candidateStreak = 0;
        emptyStreak++;

        // Hide meme after DROP_THRESHOLD empty frames
        if (emptyStreak >= DROP_THRESHOLD) {
            candidateGesture = null;
            setActiveMemeGesture(null);
        }
    }

    updateDebugHUD(rawGesture);
}

function setActiveMemeGesture(gesture) {
    if (gesture === currentActiveGesture) return;

    currentActiveGesture = gesture;

    // Highlight corresponding reference pill
    gesturePills.forEach(pill => {
        if (pill.dataset.gesture === gesture) {
            pill.classList.add("active");
        } else {
            pill.classList.remove("active");
        }
    });

    if (gesture && GESTURE_MEMES[gesture]) {
        memeImage.src = GESTURE_MEMES[gesture];
        memeBadge.textContent = gesture;
        memeOverlay.classList.remove("hidden");
    } else {
        memeOverlay.classList.add("hidden");
    }
}

function updateDebugHUD(rawGesture) {
    debugActiveGesture.textContent = currentActiveGesture || "None";
    debugRawGesture.textContent = rawGesture || "None";
    debugStability.textContent = `${candidateStreak} / ${STABILITY_THRESHOLD}`;

    if (currentActiveGesture) {
        debugActiveGesture.className = "debug-value highlight";
    } else {
        debugActiveGesture.className = "debug-value";
    }
}

function updateFPS() {
    frameCount++;
    const now = performance.now();
    const elapsed = now - lastFrameTime;

    if (elapsed >= 1000) {
        fps = Math.round((frameCount * 1000) / elapsed);
        debugFps.textContent = `${fps} FPS`;
        frameCount = 0;
        lastFrameTime = now;
    }
}

// ====================================================================
// 7. MEDIAPIPE FRAME RENDERING LOOP
// ====================================================================

function onResults(results) {
    if (!loadingOverlay.classList.contains("hidden")) {
        loadingOverlay.classList.add("hidden");
    }

    updateFPS();

    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;

    // Draw camera frame
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(
        results.image,
        0,
        0,
        canvasElement.width,
        canvasElement.height
    );

    const handsCount = results.multiHandLandmarks ? results.multiHandLandmarks.length : 0;
    debugHandsCount.textContent = handsCount;

    // Draw skeleton joints and connections
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        for (const landmarks of results.multiHandLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
                color: "rgba(224, 122, 95, 0.75)",
                lineWidth: 3
            });
            drawLandmarks(canvasCtx, landmarks, {
                color: "#ffffff",
                fillColor: "#e07a5f",
                lineWidth: 1.5,
                radius: 3.5
            });
        }
    }

    canvasCtx.restore();

    // Classify gestures & process stability buffer
    const rawDetectedGesture = classifyGestures(results.multiHandLandmarks);
    processGestureStability(rawDetectedGesture);
}

// ====================================================================
// 8. INITIALIZE APPLICATION
// ====================================================================

async function initializeApp() {
    try {
        statusText.textContent = "Loading Google MediaPipe Hands model...";

        const hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
            }
        });

        // Set maxNumHands: 2 so MediaPipe tracks both hands
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.55,
            minTrackingConfidence: 0.55
        });

        hands.onResults(onResults);

        statusText.textContent = "Requesting webcam access...";

        const camera = new Camera(videoElement, {
            onFrame: async () => {
                await hands.send({ image: videoElement });
            },
            width: 640,
            height: 480
        });

        await camera.start();
    } catch (err) {
        console.error("Initialization Error:", err);
        statusText.textContent = `Error: ${err.message || "Camera access failed"}. Make sure camera permissions are enabled and you are running via http://localhost.`;
    }
}

window.addEventListener("DOMContentLoaded", initializeApp);
