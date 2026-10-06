/**
 * MedVix Unified PDF Engine v7.0
 * File 7 of 8 — AST-to-Typst Markup Compiler
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The only file in the engine that knows what a "note", "exam", "MCQ sheet",
 * "answer key", or "analytics report" is. It translates a validated AST
 * (from File 2) into a complete Typst source string, composing:
 *
 *   • File 4's design tokens         ( `#let` bindings )
 *   • File 5's master frame          ( `#set page(...)` + running chrome )
 *   • File 6's visual components     ( cards, tables, notices, MCQ grids, ... )
 *   • File 3's loaded assets         ( logo, QR )
 *
 * Public API
 * ──────────
 *   compileDocumentToTypst(type, data) → string
 *   COMPILERS                          → frozen map of type → function
 *   COMPILER_TYPES                     → frozen list of supported type keys
 *   CompileError                       → typed error with .details
 *
 * Guarantees
 * ──────────
 *   • Pure          — no DOM, no fetch, no side effects.
 *   • Deterministic — same AST → byte-identical Typst source.
 *   • Trusting      — reads AST fields assuming File 2 already sanitized them.
 *   • Non-mutating  — never writes to the AST or any parameter.
 *   • Registry-safe — rejects unknown types with a structured error.
 *   • Self-checking — verifies every schema in File 2 has a compiler.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as C                              from './components.js';
import { renderBaseSetup }                 from './base-template.js';
import { renderTypstTokens }               from './tokens.js';
import { getLogoBase64, getQrBase64 }      from './assets.js';
import { DOC_TYPES as SCHEMA_TYPES }       from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Errors
// ═══════════════════════════════════════════════════════════════════════════

export class CompileError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CompileError';
    this.details = details;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Constants shared across every document type
// ═══════════════════════════════════════════════════════════════════════════

const FOOTER_LEFT  = 'MedVix • Medical Learning Platform';
const FOOTER_RIGHT = 'medvix.co.ke';

const WATERMARK_LINE_1 = 'Created by MedVix';
const WATERMARK_LINE_2 = 'Join us today';

const BRAND_NAME    = 'MedVix';
const BRAND_TAGLINE = 'Medical Exam Room Pro';

const LANGUAGE = 'en-US';
const THEME    = 'light';

const COPYRIGHT = '© 2026 MedVix';

/** Per-type header/footer chrome. Single source of truth for each document. */
const CHROME = Object.freeze({
  notes: {
    headerTitle:    'PERSONAL NOTES',
    headerSubtitle: 'Version 1.0',
    footerCenter:   'Medical Notes Export • Learning Material'
  },
  exam: {
    headerTitle:    'MEDICAL PRACTICE EXAMINATION',
    headerSubtitle: 'Generated for Learning & Self Assessment',
    footerCenter:   'Exam Assessment • Generated Document'
  },
  'mcq-sheet': {
    headerTitle:    'MCQ ANSWER SHEET',
    headerSubtitle: 'Student Response Document',
    footerCenter:   'MCQ Answer Sheet • Student Response'
  },
  'answer-key': {
    headerTitle:    'ANSWERS & MARKING SCHEME',
    headerSubtitle: 'Generated Study Document',
    footerCenter:   'Answers & Explanations • Study Resource'
  },
  analytics: {
    headerTitle:    'PERFORMANCE REPORT',
    headerSubtitle: 'Analytics & Progress Insights',
    footerCenter:   'Performance Analytics Report • Personal Progress'
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Assembly helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Join non-empty fragments with a double newline. */
function assemble(fragments) {
  return fragments
    .filter(f => typeof f === 'string' && f.trim().length > 0)
    .map(f => f.trim())
    .join('\n\n');
}

/** Compose the File 4 token block followed by the File 5 setup block. */
function buildSetup(docTypeKey) {
  const chrome = CHROME[docTypeKey];
  if (!chrome) {
    throw new CompileError(`No chrome defined for document type "${docTypeKey}"`, { type: docTypeKey });
  }

  let logoBase64;
  try {
    logoBase64 = getLogoBase64();
  } catch (err) {
    // File 1 guarantees assets are loaded before File 7 runs.
    // If this fires, it is a bug in File 1's orchestration, not in the AST.
    throw new CompileError(
      'Logo unavailable — loadAssets() must resolve before compileDocumentToTypst()',
      { cause: err }
    );
  }

  const tokens = renderTypstTokens(THEME);
  const setup  = renderBaseSetup({
    logoBase64,
    headerTitle:        chrome.headerTitle,
    headerSubtitle:     chrome.headerSubtitle,
    headerBrandName:    BRAND_NAME,
    headerBrandTagline: BRAND_TAGLINE,
    headerRepeats:      false,                    // brand bar on first page only
    footerLeft:         FOOTER_LEFT,
    footerCenter:       chrome.footerCenter,
    footerRight:        FOOTER_RIGHT,
    watermarkLine1:     WATERMARK_LINE_1,
    watermarkLine2:     WATERMARK_LINE_2,
    language:           LANGUAGE,
    theme:              THEME
  });

  return [tokens, setup].join('\n');
}

/** Compose File 6's end page from the AST's end-page fields. */
function buildEndPage(data) {
  let qrBase64 = '';
  try {
    qrBase64 = getQrBase64();
  } catch {
    // Non-fatal — end page renders without a QR code.
    qrBase64 = '';
  }

  return C.endPage({
    title:      data.endTitle    || 'Document Complete',
    subtitle:   data.endSubtitle || '',
    message:    data.endMessage  || '',
    features:   Array.isArray(data.endFeatures) ? data.endFeatures : [],
    ctaText:    data.ctaText     || '',
    ctaUrl:     data.ctaUrl      || '',
    qrBase64,
    copyright:  COPYRIGHT,
    disclaimer: data.disclaimer  || ''
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Shared first-page fragments
// ═══════════════════════════════════════════════════════════════════════════

/** A student name / date fill-in row used on exam and MCQ-sheet first pages. */
function studentInfoRow() {
  return [
    '#grid(',
    '  columns: (1fr, 1fr),',
    '  gutter: 24pt,',
    '  [',
    '    #text(weight: "bold")[Student Name:]',
    '    #v(6pt)',
    '    #line(length: 100%, stroke: border-width-hairline + text-light)',
    '  ],',
    '  [',
    '    #text(weight: "bold")[Date:]',
    '    #v(6pt)',
    '    #line(length: 100%, stroke: border-width-hairline + text-light)',
    '  ]',
    ')',
    '#v(16pt)'
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Per-type compilers
// ═══════════════════════════════════════════════════════════════════════════
//
// Each compiler is a pure function `(data) => string`. It reads only the
// fields declared in its schema in File 2, and it never mutates its input.

// ── Notes ──────────────────────────────────────────────────────────────────

function compileNotes(data) {
  // First-page intro: subject/topic subtitle line + metadata grid.
  const subtitleParts = [];
  if (data.subject) subtitleParts.push(data.subject);
  if (data.topic)   subtitleParts.push(data.topic);
  const subtitle = subtitleParts.join(' • ');

  const introParts = [];
  if (subtitle) {
    introParts.push(`#text(size: font-size-md, fill: text-muted)[${subtitle}]`);
    introParts.push('#v(12pt)');
  }
  introParts.push(C.metaGrid({
    cells: [
      { label: 'Owner',      value: data.owner  || 'Student' },
      { label: 'Generated',  value: data.date   || '' },
      { label: 'Subject',    value: data.subject || 'General' },
      { label: 'Export ID',  value: data.id      || '' }
    ],
    columns: 4
  }));
  introParts.push('#v(20pt)');

  // Body: File 2 has already converted `data.content` HTML → Typst markup.
  const body = data.content || '';

  return assemble([
    buildSetup('notes'),
    introParts.join('\n'),
    body,
    buildEndPage(data)
  ]);
}

// ── Exam ───────────────────────────────────────────────────────────────────

function compileExam(data) {
  const questions  = Array.isArray(data.questions) ? data.questions : [];
  const totalMarks = Number.isFinite(data.totalMarks) && data.totalMarks > 0
    ? data.totalMarks
    : questions.length;

  // Title block.
  const subtitleLine =
    `${questions.length} Questions • ${totalMarks} Marks • ${data.difficulty || 'Moderate'} Difficulty`;

  const introParts = [];
  introParts.push(C.docTitle({ title: data.title, subtitle: subtitleLine }));

  if (data.studentInfo === true) {
    introParts.push(studentInfoRow());
  }

  // Metadata table (4 rows, 2 columns).
  introParts.push(C.metaTable({
    rows: [
      [{ label: 'Subject',        value: data.subject || 'Medical Science' },
       { label: 'Topics',         value: data.topics  || '' }],
      [{ label: 'Questions',      value: String(questions.length) },
       { label: 'Total Marks',    value: String(totalMarks) }],
      [{ label: 'Time Allowed',   value: data.duration  || '2 Hours' },
       { label: 'Difficulty',     value: data.difficulty || 'Moderate' }],
      [{ label: 'Date Generated', value: data.date || '' },
       { label: 'Exam ID',        value: data.id   || '' }]
    ]
  }));
  introParts.push('#v(16pt)');

  // Educational-use notice.
  introParts.push(C.noticeBox({
    title: 'Educational Use',
    body: 'This examination has been generated by MedVix for revision, practice and self-assessment. It is not an official institutional examination.'
  }));
  introParts.push('#v(16pt)');

  // Instructions list.
  introParts.push('#text(size: font-size-md, weight: "bold", fill: brand-primary)[Instructions]');
  introParts.push('#v(6pt)');
  introParts.push(C.numberedList({
    items: [
      'Read every question carefully before answering.',
      'Answer all questions unless otherwise stated.',
      'Each question carries the marks indicated.',
      'Manage your time effectively.',
      'Review your answers before submission where applicable.'
    ]
  }));
  introParts.push('#v(4pt)');
  introParts.push(C.divider());
  introParts.push('#v(16pt)');

  // Body: one questionBlock per question.
  const bodyParts = [];
  for (const q of questions) {
    if (!q || !q.text) continue;
    bodyParts.push(C.questionBlock({
      id: q.id,
      text: q.text,
      options: Array.isArray(q.options) ? q.options : [],
      marginBottomPt: 16
    }));
  }

  return assemble([
    buildSetup('exam'),
    introParts.join('\n'),
    bodyParts.join('\n'),
    buildEndPage(data)
  ]);
}

// ── MCQ Answer Sheet ───────────────────────────────────────────────────────

function compileMcqSheet(data) {
  const total = Math.max(1, Math.floor(Number(data.totalQuestions) || 60));

  const introParts = [];
  introParts.push(C.docTitle({
    title: data.title,
    subtitle: 'Mark one circle per question (A, B, C, D, or E)'
  }));

  // Meta: studentInfo adds two extra rows.
  const rows = [];
  if (data.studentInfo === true) {
    rows.push([
      { label: 'Student Name', value: '' },
      { label: 'Date',         value: '' }
    ]);
  }
  rows.push([
    { label: 'Exam ID',         value: data.id || '' },
    { label: 'Total Questions', value: String(total) }
  ]);
  introParts.push(C.metaTable({ rows }));
  introParts.push('#v(16pt)');

  // Instructions.
  introParts.push('#text(size: font-size-md, weight: "bold", fill: brand-primary)[Instructions]');
  introParts.push('#v(6pt)');
  introParts.push(C.bulletList({
    items: [
      'Fill in one bubble only for each question.',
      'If you make a mistake, cross it out and fill the correct one clearly.',
      'Do not write outside the answer grid.'
    ]
  }));
  introParts.push('#v(12pt)');

  // Body: the paginated MCQ grid.
  const body = C.mcqGrid({
    totalQuestions: total,
    optionLabels:   ['A', 'B', 'C', 'D', 'E'],
    rowsPerPage:    40,
    columns:        2,
    rowGutterPt:    6
  });

  return assemble([
    buildSetup('mcq-sheet'),
    introParts.join('\n'),
    body,
    buildEndPage(data)
  ]);
}

// ── Answer Key ─────────────────────────────────────────────────────────────

function compileAnswerKey(data) {
  const answers = Array.isArray(data.answers) ? data.answers : [];
  const totalMarks = answers.length;

  const introParts = [];
  introParts.push(C.docTitle({
    title: data.title,
    subtitle: data.subtitle || ''
  }));

  introParts.push(C.metaGrid({
    cells: [
      { label: 'Subject',      value: data.subject || 'General' },
      { label: 'Questions',    value: `${answers.length} Questions` },
      { label: 'Total Marks',  value: `${totalMarks} Marks` },
      { label: 'Document',     value: 'Answer Guide' }
    ],
    columns: 4
  }));
  introParts.push('#v(24pt)');

  const bodyParts = [];
  for (const a of answers) {
    if (!a) continue;
    bodyParts.push(C.answerBlock({
      id: a.id,
      question: a.question,
      correctOption: a.correctOption,
      explanation: a.explanation   // File 2 already normalized this shape
    }));
  }

  return assemble([
    buildSetup('answer-key'),
    introParts.join('\n'),
    bodyParts.join('\n'),
    buildEndPage(data)
  ]);
}

// ── Analytics ──────────────────────────────────────────────────────────────

/**
 * Analytics renders a two-page report followed by the end page.
 *
 *   • Page 1: metrics grid, insight, topic table (page-one slice).
 *   • Page 2: second topic table, second insight, chart placeholders.
 *   • End page.
 *
 * The layout structure is fixed; the content is data-driven. When the AST
 * supplies no metrics/topics/insights, the compiler falls back to a small
 * set of defaults so the document still renders a usable template.
 */

const ANALYTICS_DEFAULT_METRICS = Object.freeze([
  Object.freeze({ label: 'Overall Rating',       value: '—' }),
  Object.freeze({ label: 'Questions Attempted',  value: '0' }),
  Object.freeze({ label: 'Accuracy',             value: '0%' }),
  Object.freeze({ label: 'Study Streak',         value: '0 Days' })
]);

const ANALYTICS_DEFAULT_TOPICS_PAGE1 = Object.freeze([
  Object.freeze({ name: 'Cardiovascular Physiology', questions: '—', accuracy: '—', trend: '—' }),
  Object.freeze({ name: 'Upper Limb Anatomy',        questions: '—', accuracy: '—', trend: '—' }),
  Object.freeze({ name: 'Neuroanatomy',              questions: '—', accuracy: '—', trend: '—' })
]);

const ANALYTICS_DEFAULT_INSIGHT_1 =
  'Continued practice in your weaker areas will close the largest gaps in the shortest time.';

const ANALYTICS_DEFAULT_INSIGHT_2 =
  'Increase focused revision in your least accurate subject to lift your overall score.';

function compileAnalytics(data) {
  const metrics  = Array.isArray(data.metrics)  && data.metrics.length  > 0 ? data.metrics  : ANALYTICS_DEFAULT_METRICS;
  const topics   = Array.isArray(data.topics)   ? data.topics   : [];
  const insights = Array.isArray(data.insights) && data.insights.length > 0 ? data.insights : [];

  // ── Page 1: intro + first-page analytics content ────────────────────────
  const introParts = [];
  introParts.push(C.docTitle({
    title: data.title || 'Student Performance Analytics',
    subtitle: 'Personal Learning Progress Overview'
  }));

  introParts.push(C.metaGrid({
    cells: metrics.slice(0, 4).map(m => ({ label: m.label, value: m.value })),
    columns: Math.max(1, Math.min(4, metrics.length))
  }));
  introParts.push('#v(24pt)');

  // Progress Highlights section.
  introParts.push(`#text(size: font-size-lg, weight: "bold", fill: brand-primary)[Progress Highlights]`);
  introParts.push('#v(12pt)');
  introParts.push(C.chartPlaceholder({ label: '[ Performance Over Time Chart ]', heightPt: 120 }));
  introParts.push('#v(12pt)');

  const insight1 = insights[0] || { label: 'Insight', text: ANALYTICS_DEFAULT_INSIGHT_1 };
  introParts.push(C.insightBox({ label: insight1.label || 'Insight', text: insight1.text }));
  introParts.push('#v(16pt)');

  // Page-1 topic table.
  const page1Topics = topics.length > 0 ? topics.slice(0, 3) : ANALYTICS_DEFAULT_TOPICS_PAGE1;
  introParts.push(C.topicTable({
    columns: ['Topic', 'Questions', 'Accuracy', 'Trend'],
    rows: page1Topics.map(t => [t.name, t.questions, t.accuracy, t.trend])
  }));

  // ── Page 2: second section of analytics ─────────────────────────────────
  const page2Parts = [];
  page2Parts.push(C.pageBreak());
  page2Parts.push(`#text(size: font-size-lg, weight: "bold", fill: brand-primary)[Topic Breakdown & Time Analysis]`);
  page2Parts.push('#v(12pt)');
  page2Parts.push(C.chartPlaceholder({ label: '[ Questions by Subject Area ]', heightPt: 110 }));
  page2Parts.push('#v(12pt)');

  const page2Topics = topics.length > 3 ? topics.slice(3, 7) : [];
  if (page2Topics.length > 0) {
    page2Parts.push(C.topicTable({
      columns: ['Topic', 'Questions', 'Accuracy', 'Trend'],
      rows: page2Topics.map(t => [t.name, t.questions, t.accuracy, t.trend])
    }));
  } else {
    page2Parts.push(C.topicTable({
      columns: ['Metric', 'This Month', 'Last Month', 'Change'],
      rows: [
        ['Total Study Time',     '—', '—', '—'],
        ['Avg. Session Length',  '—', '—', '—'],
        ['Questions per Day',    '—', '—', '—'],
        ['Weakest Subject',      '—', '—', '—']
      ]
    }));
  }
  page2Parts.push('#v(12pt)');

  const insight2 = insights[1] || { label: 'Recommendation', text: ANALYTICS_DEFAULT_INSIGHT_2 };
  page2Parts.push(C.insightBox({ label: insight2.label || 'Recommendation', text: insight2.text }));
  page2Parts.push('#v(12pt)');

  page2Parts.push(C.chartPlaceholder({ label: '[ Daily Streak Calendar / Heatmap ]', heightPt: 100 }));

  return assemble([
    buildSetup('analytics'),
    introParts.join('\n'),
    page2Parts.join('\n'),
    buildEndPage(data)
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Registry & dispatcher
// ═══════════════════════════════════════════════════════════════════════════

export const COMPILERS = Object.freeze({
  'notes':       compileNotes,
  'exam':        compileExam,
  'mcq-sheet':   compileMcqSheet,
  'answer-key':  compileAnswerKey,
  'analytics':   compileAnalytics
});

export const COMPILER_TYPES = Object.freeze(Object.keys(COMPILERS));

/**
 * Compile a validated AST into a complete Typst source string.
 *
 * @param {string} type   Document type key — must exist in COMPILERS.
 * @param {object} data   Frozen AST from File 2's validateDocData().
 * @returns {string}      Complete Typst markup ready for File 8.
 * @throws {CompileError} On unknown type or malformed input.
 */
export function compileDocumentToTypst(type, data) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new CompileError('Document type must be a non-empty string', { received: typeof type });
  }

  const compiler = COMPILERS[type];
  if (!compiler) {
    throw new CompileError(`No compiler registered for document type "${type}"`, {
      type,
      available: COMPILER_TYPES.slice()
    });
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CompileError('Document data must be a plain object', {
      type,
      received: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data
    });
  }

  try {
    const out = compiler(data);
    if (typeof out !== 'string' || out.length === 0) {
      throw new CompileError(`Compiler for "${type}" returned empty output`, { type });
    }
    return out;
  } catch (err) {
    if (err instanceof CompileError) throw err;
    throw new CompileError(
      `Compiler for "${type}" failed: ${err && err.message ? err.message : String(err)}`,
      { type, cause: err }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Registry ↔ schema consistency check
// ═══════════════════════════════════════════════════════════════════════════

(function assertSchemaCompilerBijection() {
  const schemaSet   = new Set(SCHEMA_TYPES);
  const compilerSet = new Set(COMPILER_TYPES);

  const missingCompilers = SCHEMA_TYPES.filter(t => !compilerSet.has(t));
  const orphanCompilers  = COMPILER_TYPES.filter(t => !schemaSet.has(t));

  const errors = [];
  if (missingCompilers.length > 0) {
    errors.push(`schemas without compilers: ${missingCompilers.join(', ')}`);
  }
  if (orphanCompilers.length > 0) {
    errors.push(`compilers without schemas: ${orphanCompilers.join(', ')}`);
  }
  if (errors.length > 0) {
    throw new Error(
      '[pdf-engine/compiler] Registry/schema mismatch — ' + errors.join('; ')
    );
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// 8. Ready
// ═══════════════════════════════════════════════════════════════════════════

// No logging, no side effects beyond the bijection check above. Every
// compiler is pure and deterministic; the dispatcher is a strict router.