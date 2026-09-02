// scripts/timer.js

/**
 * Adaptive Timer Module
 * Manages per-question timer with difficulty-based durations.
 * Provides visual feedback via color thresholds and callbacks.
 */

import * as utils from './utils.js';

// Difficulty to time mapping (milliseconds)
const DIFFICULTY_TIMES = {
    1: 21000, // Easy: 21 seconds
    2: 30000, // Medium: 30 seconds
    3: 42000, // Hard: 42 seconds
    4: 54000, // Expert: 54 seconds
    5: 54000  // Expert (if level 5 exists)
};

// Color thresholds (percentage of time remaining)
const COLOR_THRESHOLDS = {
    GREEN: 0.7,   // >70% -> green
    YELLOW: 0.3,  // 30-70% -> yellow
    RED: 0.05     // <5% -> red flashing
};

// ==================== EXPORT THE MAP ====================
export { DIFFICULTY_TIMES };

/**
 * Calculate total time (in seconds) for a list of questions.
 * Each question's difficulty determines its time (from DIFFICULTY_TIMES).
 * If a question is missing difficulty, defaults to 3 (42s).
 * @param {Array} questions - array of question objects
 * @returns {number} total seconds
 */
export function getTotalTimeForQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) return 0;
    let totalSeconds = 0;
    questions.forEach(q => {
        const diff = q.difficulty || 3;
        const ms = DIFFICULTY_TIMES[diff] || DIFFICULTY_TIMES[3];
        totalSeconds += ms / 1000;
    });
    return totalSeconds;
}

// ==================== Timer Class ====================
class Timer {
    constructor(difficulty, timingMode, customTime) {
        this.difficulty = difficulty;
        this.timingMode = timingMode; // 'adaptive', 'fixed', 'none'
        this.customTime = customTime; // seconds (for fixed mode)
        this.totalTime = this._calculateTotalTime();
        this.timeRemaining = this.totalTime;
        this.startTime = null;
        this.intervalId = null;
        this.isPaused = false;
        this.pauseDuration = 0;
        this.pauseStart = null;
    }

    _calculateTotalTime() {
        if (this.timingMode === 'none') return null;
        if (this.timingMode === 'fixed') {
            return (this.customTime || 30) * 1000;
        }
        // Adaptive mode
        return DIFFICULTY_TIMES[this.difficulty] || 30000;
    }

    _getColor(percentage) {
        if (percentage > COLOR_THRESHOLDS.GREEN) return 'green';
        if (percentage > COLOR_THRESHOLDS.YELLOW) return 'yellow';
        return 'red';
    }

    /**
     * Start the timer.
     * @param {Function} onTick - callback({remaining, percentage, color, shouldFlash})
     * @param {Function} onExpire - callback when time reaches zero
     */
    start(onTick, onExpire) {
        if (this.timingMode === 'none' || !this.totalTime) return;

        this.startTime = Date.now() - this.pauseDuration;
        this.pauseDuration = 0;
        this.isPaused = false;

        this.intervalId = setInterval(() => {
            if (this.isPaused) return;

            const now = Date.now();
            const elapsed = now - this.startTime;
            this.timeRemaining = Math.max(0, this.totalTime - elapsed);
            const percentage = this.timeRemaining / this.totalTime;
            const color = this._getColor(percentage);
            const shouldFlash = percentage < COLOR_THRESHOLDS.RED;

            onTick({
                remaining: this.timeRemaining,
                percentage,
                color,
                shouldFlash
            });

            if (this.timeRemaining <= 0) {
                this.stop();
                onExpire();
            }
        }, 100); // 100ms updates for smoothness
    }

    pause() {
        if (this.isPaused || this.timingMode === 'none') return;
        this.isPaused = true;
        this.pauseStart = Date.now();
    }

    resume() {
        if (!this.isPaused || this.timingMode === 'none') return;
        const pauseDuration = Date.now() - this.pauseStart;
        this.pauseDuration += pauseDuration;
        this.startTime += pauseDuration;
        this.isPaused = false;
        this.pauseStart = null;
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    getTimeSpent() {
        if (!this.startTime) return 0;
        const now = Date.now();
        let elapsed = now - this.startTime;
        if (this.isPaused && this.pauseStart) {
            elapsed -= (now - this.pauseStart);
        }
        return Math.min(elapsed, this.totalTime);
    }

    getRemaining() {
        return this.timeRemaining;
    }
}

// ==================== Public API ====================

/**
 * Create a new timer instance.
 * @param {number} difficulty - 1-5
 * @param {string} timingMode - 'adaptive', 'fixed', 'none'
 * @param {number|null} customTime - seconds for fixed mode
 * @returns {Object} timer instance with methods
 */
export function createTimer(difficulty, timingMode = 'adaptive', customTime = null) {
    return new Timer(difficulty, timingMode, customTime);
}

/**
 * Format milliseconds to MM:SS (wrapper around utils.formatTime).
 * @param {number} ms
 * @returns {string}
 */
export function formatTime(ms) {
    return utils.formatTime(Math.floor(ms / 1000));
}