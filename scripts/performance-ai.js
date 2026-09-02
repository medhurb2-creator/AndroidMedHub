// /scripts/performance-ai.js
// MedVix Performance AI – handles plan generation, adoption, regeneration, amendments, cancellation,
// and AI‑powered insights generation from raw performance data.

// ============================================================================
//  AI INSIGHTS GENERATION (used by analytics.js)
// ============================================================================

/**
 * Generate AI insights from raw performance data.
 * @param {object} rawData - Contains exams, weakAreas, trends, studyPatterns, subjectAnalysis, etc.
 * @returns {object|null} { insights, recommendations, focusTopics } or null if fails.
 */
export async function generateAIInsightsFromRaw(rawData) {
  // Build a comprehensive, structured prompt using raw data
  const prompt = buildPrompt(rawData);

  try {
    const response = await ai.sendMessageToAI({
      message: prompt,
      chatId: null,
      modes: [],
      file: null
    });

    // Parse the response – expected JSON
    let parsed;
    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(response.text);
    } catch (e) {
      console.warn('[PerformanceAI] Failed to parse AI response, using fallback');
      return null;
    }

    // Validate required keys
    if (!parsed.insights && !parsed.recommendations && !parsed.focusTopics) {
      console.warn('[PerformanceAI] AI response missing required keys');
      return null;
    }

    return {
      insights: parsed.insights || 'Keep up the good work!',
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      focusTopics: Array.isArray(parsed.focusTopics) ? parsed.focusTopics : []
    };
  } catch (e) {
    console.warn('[PerformanceAI] AI insight generation failed', e);
    return null;
  }
}

/**
 * Build a detailed prompt from raw data.
 */
function buildPrompt(raw) {
  const {
    exams = [],
    weakAreas = [],
    trends = [],
    studyPatterns = {},
    subjectAnalysis = []
  } = raw;

  // Summarize stats in a structured way
  const totalExams = exams.length;
  const totalQuestions = exams.reduce((sum, e) => sum + (e.totalQuestions || 0), 0);
  const totalCorrect = exams.reduce((sum, e) => sum + (e.correctAnswers || 0), 0);
  const avgScore = totalQuestions ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
  const bestScore = exams.length ? Math.max(...exams.map(e => e.scorePercentage || 0)) : 0;
  const worstScore = exams.length ? Math.min(...exams.map(e => e.scorePercentage || 0)) : 0;
  const totalTimeHours = exams.reduce((sum, e) => sum + (e.timeSpent || 0), 0) / (1000 * 60 * 60);

  const weakAreasList = weakAreas.slice(0, 5).map(w => `${w.topic} (${Math.round(w.score)}%)`).join(', ');
  const subjectMastery = subjectAnalysis.map(s => `${s.subject} (${s.percentage}%)`).join(', ');
  const bestDay = studyPatterns.bestDay || 'N/A';
  const bestHour = studyPatterns.bestHour !== null ? `${studyPatterns.bestHour}:00` : 'N/A';
  const avgSession = studyPatterns.averageSessionTime ? `${studyPatterns.averageSessionTime} min` : 'N/A';
  const consistency = studyPatterns.consistency ? `${studyPatterns.consistency}%` : 'N/A';
  const streak = studyPatterns.streak || 0;

  return `
You are MedVix AI, a medical exam performance coach. The user has provided the following raw performance data:

- Total exams: ${totalExams}
- Total questions: ${totalQuestions}
- Average score: ${avgScore}%
- Best score: ${bestScore}%
- Worst score: ${worstScore}%
- Total study time: ${totalTimeHours.toFixed(1)} hours
- Subject mastery: ${subjectMastery || 'None yet'}
- Weak areas (score below 70%): ${weakAreasList || 'None detected'}
- Best study day: ${bestDay}
- Best study hour: ${bestHour}
- Average session length: ${avgSession}
- Consistency: ${consistency}
- Current streak: ${streak} days

Based on this data, provide **3–5 concise, actionable, and encouraging recommendations**. Focus on study strategies, time management, and topic-specific advice. Keep the tone professional yet supportive.

Output **only** a JSON object with exactly these keys:
- "insights": a string summary of the user's overall performance.
- "recommendations": an array of strings (each recommendation).
- "focusTopics": an array of strings (topics the user should prioritise).

Do not include any other text or markdown.
`;
}

// ============================================================================
//  PERFORMANCE AI PLANNER CLASS (unchanged)
// ============================================================================

/**
 * PerformanceAI class – manages AI‑driven study planning for the Performance page.
 * All data is stored in localStorage under the same keys used by the main planner modules.
 */
export class PerformanceAI {
  constructor(options = {}) {
    // Callbacks for UI updates
    this.onPlanGenerated = options.onPlanGenerated || (() => {});
    this.onPlanAdopted = options.onPlanAdopted || (() => {});
    this.onPlanRegenerated = options.onPlanRegenerated || (() => {});
    this.onPlanAmended = options.onPlanAmended || (() => {});
    this.onPlanCancelled = options.onPlanCancelled || (() => {});
    this.onAmendInputShow = options.onAmendInputShow || (() => {});
    this.onAmendInputHide = options.onAmendInputHide || (() => {});

    // Internal state
    this.lastInputs = null;           // last used inputs for regeneration
    this.lastPlanData = null;         // the most recently generated plan data
    this.adopted = false;             // whether the last plan was adopted
  }

  /**
   * Generate a study plan based on user inputs.
   * @param {string} examDate - YYYY-MM-DD
   * @param {string} subjects - comma-separated subject names
   * @param {number} hoursPerDay - daily study hours
   * @param {string} weakSubjects - comma-separated weak subjects (optional)
   * @param {string} preferredTimes - e.g. "08:00-12:00" (optional)
   * @returns {object} { display: string, success: boolean, planData: object }
   */
  generatePlan(examDate, subjects, hoursPerDay, weakSubjects, preferredTimes) {
    // Store inputs for later regeneration
    this.lastInputs = { examDate, subjects, hoursPerDay, weakSubjects, preferredTimes };
    this.adopted = false;

    // Parse subjects
    const subjectList = subjects.split(',').map(s => s.trim()).filter(Boolean);
    const weakList = weakSubjects ? weakSubjects.split(',').map(s => s.trim()).filter(Boolean) : [];

    // Calculate days left
    const now = new Date();
    const exam = new Date(examDate + 'T00:00:00');
    const daysLeft = Math.max(1, Math.ceil((exam - now) / (1000 * 60 * 60 * 24)));

    // --- Build the plan ---
    const planData = this._buildPlanData(subjectList, weakList, daysLeft, hoursPerDay, preferredTimes);
    const displayText = this._formatPlanDisplay(planData, examDate, daysLeft, subjectList, weakList, hoursPerDay);

    this.lastPlanData = planData;
    this.onPlanGenerated(planData);
    return { display: displayText, success: true, planData };
  }

  /**
   * Adopt the last generated plan – populate timetable, topics, checklist, and reminders.
   */
  adoptPlan(planData) {
    if (!planData) {
      console.warn('No plan data to adopt.');
      return false;
    }

    // Save each module to localStorage using the same keys as the main planner
    this._saveToLocalStorage('medvix_planner_timetable', planData.timetable || {});
    this._saveToLocalStorage('medvix_planner_topics', planData.topics || []);
    this._saveToLocalStorage('medvix_planner_checklist', planData.checklist || []);
    // Reminders are static in the UI; we could store them but they are not persisted now.
    // If you want dynamic reminders, uncomment the next line and adapt the UI.
    // this._saveToLocalStorage('medvix_planner_reminders', planData.reminders || []);

    this.adopted = true;
    this.onPlanAdopted();
    return true;
  }

  /**
   * Regenerate a plan using the last inputs.
   * @returns {object|null} regenerated plan result, or null if no inputs exist.
   */
  regeneratePlan() {
    if (!this.lastInputs) {
      console.warn('No previous inputs to regenerate.');
      return null;
    }
    const { examDate, subjects, hoursPerDay, weakSubjects, preferredTimes } = this.lastInputs;
    const result = this.generatePlan(examDate, subjects, hoursPerDay, weakSubjects, preferredTimes);
    this.onPlanRegenerated(result.planData);
    return result;
  }

  /**
   * Show the amendment input field.
   */
  showAmendInput() {
    this.onAmendInputShow();
  }

  /**
   * Amend the last plan with a natural‑language description.
   * @param {string} description - e.g. "Add more Anatomy sessions and move Physiology to morning."
   * @returns {object|null} new plan result, or null if no plan exists.
   */
  amendPlan(description) {
    if (!this.lastPlanData) {
      console.warn('No plan to amend. Generate one first.');
      return null;
    }
    if (!description.trim()) {
      console.warn('Amendment description cannot be empty.');
      return null;
    }

    // For demo, we'll adjust the plan based on keywords.
    // In a production version, you would call an LLM API here.
    const amended = this._applyAmendments(this.lastPlanData, description);
    this.lastPlanData = amended;
    const displayText = this._formatPlanDisplay(
      amended,
      this.lastInputs.examDate,
      this._getDaysLeft(this.lastInputs.examDate),
      amended.subjects || [],
      amended.weakList || [],
      this.lastInputs.hoursPerDay
    );
    this.onPlanAmended(amended);
    return { display: displayText, success: true, planData: amended };
  }

  /**
   * Cancel the current plan – clear state and hide actions.
   */
  cancelPlan() {
    this.lastPlanData = null;
    this.adopted = false;
    this.onPlanCancelled();
    this.onAmendInputHide(); // close amend input if open
  }

  // ────────────────────────────── Internal helpers ──────────────────────────────

  _buildPlanData(subjectList, weakList, daysLeft, hoursPerDay, preferredTimes) {
    const timetable = {};
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const startHour = preferredTimes ? parseInt(preferredTimes.split(':')[0]) || 8 : 8;

    // Generate up to 7 days of timetable
    for (let i = 0; i < Math.min(7, daysLeft); i++) {
      const day = days[i % 7];
      const slots = [];
      let h = startHour;
      const mainSubject = subjectList[i % subjectList.length];
      const weakSubject = weakList.length > 0 ? weakList[i % weakList.length] : null;

      // 4 slots per day
      slots.push({
        time: `${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:30`,
        subject: mainSubject,
        color: this._subjectColor(mainSubject)
      });
      h += 2;
      slots.push({
        time: `${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:00`,
        subject: weakSubject || mainSubject,
        color: this._subjectColor(weakSubject || mainSubject)
      });
      h += 2;
      slots.push({
        time: `${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:30`,
        subject: subjectList[(i + 1) % subjectList.length],
        color: this._subjectColor(subjectList[(i + 1) % subjectList.length])
      });
      h += 2;
      slots.push({
        time: `${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:00`,
        subject: 'Revision',
        color: 'revision'
      });
      timetable[day] = slots;
    }

    // Generate topics for each subject (one topic per subject)
    const topics = subjectList.map(s => ({
      subject: s,
      topic: `${s} – Core Concepts`,
      status: weakList.includes(s) ? 'in-progress' : 'not-started'
    }));

    // Generate a daily checklist
    const checklist = [
      { task: 'Review yesterday\'s notes', done: false },
      { task: 'Complete 50 MCQs', done: false },
      { task: 'Study weak subject', done: false },
      { task: 'Revise key concepts', done: false },
      { task: 'Plan tomorrow\'s schedule', done: false },
    ];

    // Build reminders (static for now)
    const reminders = [
      '⏰ Anatomy starts in 15 minutes.',
      '🎯 Today\'s Goal: Study 3 hours.',
      '📝 Revision reminder: Review Histology.'
    ];

    return {
      timetable,
      topics,
      checklist,
      reminders,
      subjects: subjectList,
      weakList,
      daysLeft,
      hoursPerDay,
    };
  }

  _formatPlanDisplay(planData, examDate, daysLeft, subjectList, weakList, hoursPerDay) {
    let plan = `📋 **Adaptive Study Plan**\n`;
    plan += `📅 Exam: ${this._formatDateShort(examDate)} (${daysLeft} days left)\n`;
    plan += `📚 Subjects: ${subjectList.join(', ')}\n`;
    if (weakList.length) plan += `⚠️ Weak: ${weakList.join(', ')}\n`;
    plan += `⏱️ ${hoursPerDay}h/day\n\n`;

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (let i = 0; i < Math.min(7, daysLeft); i++) {
      const day = days[i % 7];
      const slots = planData.timetable[day] || [];
      plan += `**${day}**\n`;
      slots.forEach(s => {
        plan += `  ${s.time}  ${s.subject}\n`;
      });
      plan += `\n`;
    }
    if (daysLeft > 7) {
      plan += `... and ${daysLeft - 7} more days (adaptive).\n`;
    }
    return plan.replace(/\n/g, '<br>');
  }

  _subjectColor(subject) {
    const map = {
      'Anatomy': 'anatomy',
      'Physiology': 'physiology',
      'Biochemistry': 'biochemistry',
      'Revision': 'revision',
      'MCQ': 'mcq',
      'Pathology': 'pathology',
      'Pharmacology': 'pharmacology',
    };
    return map[subject] || 'anatomy'; // fallback
  }

  _formatDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  _getDaysLeft(examDate) {
    const now = new Date();
    const exam = new Date(examDate + 'T00:00:00');
    return Math.max(1, Math.ceil((exam - now) / (1000 * 60 * 60 * 24)));
  }

  _saveToLocalStorage(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('Could not save to localStorage:', e);
    }
  }

  _applyAmendments(originalPlan, description) {
    // Simple keyword-based amendment (demo).
    // In production, you'd call an LLM API to parse the description and adjust the plan.
    const newPlan = JSON.parse(JSON.stringify(originalPlan)); // deep clone

    const desc = description.toLowerCase();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // If user mentions "more Anatomy", add extra Anatomy sessions
    if (desc.includes('more anatomy') || desc.includes('add anatomy')) {
      // Add an extra Anatomy session on Monday if not already present
      const mondaySlots = newPlan.timetable['Monday'] || [];
      if (!mondaySlots.some(s => s.subject === 'Anatomy')) {
        mondaySlots.push({
          time: '20:00–21:00',
          subject: 'Anatomy',
          color: 'anatomy'
        });
        newPlan.timetable['Monday'] = mondaySlots;
      }
    }

    // If user mentions "move Physiology to morning"
    if (desc.includes('physiology') && desc.includes('morning')) {
      // Move Physiology sessions to earlier times
      for (const day of days) {
        const slots = newPlan.timetable[day] || [];
        const physIdx = slots.findIndex(s => s.subject === 'Physiology');
        if (physIdx !== -1) {
          // Swap with first slot (morning)
          const physSlot = slots[physIdx];
          const morningSlot = slots[0];
          if (morningSlot && physSlot) {
            slots[0] = physSlot;
            slots[physIdx] = morningSlot;
          }
        }
      }
    }

    // If user mentions "add more MCQs"
    if (desc.includes('more mcq') || desc.includes('add mcq')) {
      // Add a MCQ session on Tuesday if not exists
      const tueSlots = newPlan.timetable['Tuesday'] || [];
      if (!tueSlots.some(s => s.subject === 'MCQ')) {
        tueSlots.push({
          time: '19:00–20:00',
          subject: 'MCQ',
          color: 'mcq'
        });
        newPlan.timetable['Tuesday'] = tueSlots;
      }
    }

    // Always keep the subject list and weak list for display
    newPlan.subjects = originalPlan.subjects;
    newPlan.weakList = originalPlan.weakList;
    return newPlan;
  }
}