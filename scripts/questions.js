// frontend-user/scripts/questions.js

/**
 * Question Bank Manager
 *
 * Loads questions from per‑topic JSON files (data/questions/[subject]/[topic].json)
 * and merges subjects/topics delivered by the slide-data zip (subject.json).
 * All public getters are slide-aware — callers never branch on "is this
 * slide or static?"; the merge is internal.
 *
 * Public API (uniform, no getSlideX):
 *   getSubjectMeta(id)               → { name, icon, color, questions, source }
 *   getTopicsBySubject(id)           → [{ id, name, questions }, ...]
 *   getTopicById(subjectId, topicId) → topic | null
 *   getAllSubjectIds()               → string[]   (static + slide)
 *   getAllStaticSubjectIds()         → string[]   (static only)
 *   getAllSlideSubjectIds()          → string[]   (slide only)
 *   getAllSubjects()                 → [{ id, ...meta, topics }]
 *   getQuestionsForExam(config)      → Promise<Question[]>
 *   getQuestionsByIds(ids)           → Promise<Question[]>
 *
 * Internal (only slide-data.js should call):
 *   invalidateSlideManifestCache()
 */

import * as utils from './utils.js';
import * as db from './db.js';

// ==================== SUBJECT METADATA ====================
const SUBJECT_META = {
    anatomy:        { name: 'Anatomy',       icon: 'fa-solid fa-bone',        color: '#FF6B6B', questions: 1245 },
    physiology:     { name: 'Physiology',    icon: 'fa-solid fa-heart-pulse', color: '#4ECDC4', questions: 1860 },
    biochemistry:   { name: 'Biochemistry',  icon: 'fa-solid fa-flask',       color: '#45B7D1', questions: 1650 },
    histology:      { name: 'Histology',     icon: 'fa-solid fa-microscope',  color: '#96CEB4', questions: 1365 },
    embryology:     { name: 'Embryology',    icon: 'fa-solid fa-egg',         color: '#FFEAA7', questions: 1245 },
    pathology:      { name: 'Pathology',     icon: 'fa-solid fa-disease',     color: '#DDA0DD', questions: 2250 },
    pharmacology:   { name: 'Pharmacology',  icon: 'fa-solid fa-pills',       color: '#FDCB6E', questions: 1635 },
    microbiology:   { name: 'Microbiology',  icon: 'fa-solid fa-bacteria',    color: '#E17055', questions: 1650 }
};


// ==================== COMPLETE TOPICS FROM UPDATED BLUEPRINT ====================
const TOPICS = {
    // ANATOMY - 720 questions, 9 topics
    anatomy: [
        { id: 'introduction-anatomy', name: 'Introduction to Anatomy', questions: 75 },
        { id: 'back', name: 'Back', questions: 75 },
        { id: 'upper-limb', name: 'Upper Limb', questions: 150 },
        { id: 'lower-limb', name: 'Lower Limb', questions: 150 },
        { id: 'thorax', name: 'Thorax', questions: 150 },
        { id: 'abdomen', name: 'Abdomen', questions: 150 },
        { id: 'pelvis-perineum', name: 'Pelvis & Perineum', questions: 90 },
        { id: 'head-neck', name: 'Head & Neck', questions: 150 },
        { id: 'neuroanatomy', name: 'Neuroanatomy', questions: 180 },
        { id: 'cross-sectional-anatomy', name: 'Cross‑Sectional Anatomy', questions: 75 }
    ],

    physiology: [
        { id: 'introduction-homeostasis', name: 'Introduction & Homeostasis', questions: 75 },
        { id: 'cell-physiology', name: 'Cell Physiology', questions: 120 },
        { id: 'body-fluids-compartments', name: 'Body Fluids & Compartments', questions: 75 },
        { id: 'cellular-transport', name: 'Cellular Transport', questions: 105 },
        { id: 'membrane-physiology', name: 'Membrane Physiology', questions: 75 },
        { id: 'signal-transduction', name: 'Signal Transduction', questions: 90 },
        { id: 'muscle-physiology', name: 'Muscle Physiology', questions: 105 },
        { id: 'cardiovascular', name: 'Cardiovascular', questions: 225 },
        { id: 'respiratory', name: 'Respiratory', questions: 180 },
        { id: 'renal', name: 'Renal', questions: 180 },
        { id: 'gastrointestinal', name: 'Gastrointestinal', questions: 135 },
        { id: 'endocrine', name: 'Endocrine', questions: 150 },
        { id: 'reproductive', name: 'Reproductive', questions: 90 },
        { id: 'neurophysiology', name: 'Neurophysiology', questions: 180 },
        { id: 'special-senses', name: 'Special Senses', questions: 90 },
        { id: 'integrative-physiology', name: 'Integrative Physiology', questions: 75 }
    ],

    // BIOCHEMISTRY - 810 questions, 17 topics
    biochemistry: [
        { id: 'biomolecules', name: 'Biomolecules', questions: 150 },
        { id: 'amino-acids-proteins', name: 'Amino Acids & Proteins', questions: 90 },
        { id: 'carbohydrates', name: 'Carbohydrates', questions: 90 },
        { id: 'lipids', name: 'Lipids', questions: 90 },
        { id: 'nucleic-acids', name: 'Nucleic Acids', questions: 75 },
        { id: 'enzymology', name: 'Enzymology', questions: 120 },
        { id: 'bioenergetics', name: 'Bioenergetics', questions: 75 },
        { id: 'metabolism-overview', name: 'Metabolism Overview', questions: 75 },
        { id: 'carbohydrate-metabolism', name: 'Carbohydrate Metabolism', questions: 120 },
        { id: 'lipid-metabolism', name: 'Lipid Metabolism', questions: 105 },
        { id: 'protein-metabolism', name: 'Protein Metabolism', questions: 105 },
        { id: 'integration-metabolism', name: 'Integration of Metabolism', questions: 75 },
        { id: 'molecular-biology', name: 'Molecular Biology', questions: 225 },
        { id: 'clinical-biochemistry', name: 'Clinical Biochemistry', questions: 120 },
        { id: 'nutrition', name: 'Nutrition', questions: 90 },
        { id: 'acid-base-balance', name: 'Acid‑Base Balance', questions: 75 },
        { id: 'biochemical-techniques', name: 'Biochemical Techniques', questions: 75 }
    ],

    // HISTOLOGY - 700 questions, 18 topics
    histology: [
        { id: 'introduction-histology', name: 'Introduction to Histology', questions: 75 },
        { id: 'cell-structure', name: 'Cell Structure', questions: 75 },
        { id: 'epithelial-tissue', name: 'Epithelial Tissue', questions: 90 },
        { id: 'connective-tissue', name: 'Connective Tissue', questions: 90 },
        { id: 'cartilage-bone', name: 'Cartilage & Bone', questions: 75 },
        { id: 'adipose-tissue', name: 'Adipose Tissue', questions: 75 },
        { id: 'blood-hematopoiesis', name: 'Blood & Hematopoiesis', questions: 75 },
        { id: 'muscle-tissue', name: 'Muscle Tissue', questions: 90 },
        { id: 'nervous-tissue', name: 'Nervous Tissue', questions: 90 },
        { id: 'cardiovascular-system', name: 'Cardiovascular System', questions: 75 },
        { id: 'lymphatic-system', name: 'Lymphatic System', questions: 75 },
        { id: 'respiratory-system', name: 'Respiratory System', questions: 75 },
        { id: 'digestive-system', name: 'Digestive System', questions: 75 },
        { id: 'endocrine-glands', name: 'Endocrine Glands', questions: 75 },
        { id: 'urinary-system', name: 'Urinary System', questions: 75 },
        { id: 'reproductive-system-male', name: 'Reproductive System (Male)', questions: 75 },
        { id: 'reproductive-system-female', name: 'Reproductive System (Female)', questions: 75 },
        { id: 'skin-integument', name: 'Skin & Integument', questions: 75 }
    ],

    // EMBRYOLOGY - 690 questions, 16 topics
    embryology: [
        { id: 'introduction-embryology', name: 'Introduction to Embryology', questions: 75 },
        { id: 'gametogenesis', name: 'Gametogenesis', questions: 75 },
        { id: 'fertilization', name: 'Fertilization', questions: 75 },
        { id: 'cleavage-implantation', name: 'Cleavage & Implantation', questions: 75 },
        { id: 'embryogenesis-week1-3', name: 'Embryogenesis (Weeks 1‑3)', questions: 90 },
        { id: 'embryogenesis-week3-8', name: 'Embryogenesis (Weeks 3‑8)', questions: 90 },
        { id: 'fetal-development', name: 'Fetal Development', questions: 75 },
        { id: 'placenta-membranes', name: 'Placenta & Fetal Membranes', questions: 75 },
        { id: 'birth-defects-teratology', name: 'Birth Defects & Teratology', questions: 75 },
        { id: 'cardiovascular-development', name: 'Cardiovascular Development', questions: 90 },
        { id: 'nervous-system-development', name: 'Nervous System Development', questions: 90 },
        { id: 'gastrointestinal-development', name: 'Gastrointestinal Development', questions: 90 },
        { id: 'respiratory-development', name: 'Respiratory Development', questions: 75 },
        { id: 'head-neck-development', name: 'Head & Neck Development', questions: 75 },
        { id: 'urogenital-development', name: 'Urogenital Development', questions: 90 },
        { id: 'limb-development', name: 'Limb Development', questions: 75 }
    ],

    // PATHOLOGY - 1080 questions, 27 topics
    pathology: [
        { id: 'introduction-pathology', name: 'Introduction to Pathology', questions: 75 },
        { id: 'cellular-injury', name: 'Cellular Injury', questions: 120 },
        { id: 'adaptations', name: 'Cellular Adaptations', questions: 75 },
        { id: 'intracellular-accumulations', name: 'Intracellular Accumulations', questions: 75 },
        { id: 'inflammation-acute', name: 'Acute Inflammation', questions: 90 },
        { id: 'inflammation-chronic', name: 'Chronic Inflammation', questions: 90 },
        { id: 'repair-regeneration', name: 'Repair & Regeneration', questions: 90 },
        { id: 'hemodynamic-disorders', name: 'Hemodynamic Disorders', questions: 90 },
        { id: 'thrombosis-embolism', name: 'Thrombosis & Embolism', questions: 75 },
        { id: 'shock', name: 'Shock', questions: 75 },
        { id: 'genetic-disorders', name: 'Genetic Disorders', questions: 90 },
        { id: 'immunopathology', name: 'Immunopathology', questions: 105 },
        { id: 'amyloidosis', name: 'Amyloidosis', questions: 75 },
        { id: 'neoplasia', name: 'Neoplasia', questions: 120 },
        { id: 'infectious-diseases', name: 'Infectious Diseases', questions: 90 },
        { id: 'environmental-nutritional', name: 'Environmental & Nutritional', questions: 75 },
        { id: 'cardiovascular-pathology', name: 'Cardiovascular Pathology', questions: 120 },
        { id: 'respiratory-pathology', name: 'Respiratory Pathology', questions: 105 },
        { id: 'gastrointestinal-pathology', name: 'Gastrointestinal Pathology', questions: 105 },
        { id: 'hepatobiliary-pathology', name: 'Hepatobiliary Pathology', questions: 75 },
        { id: 'renal-pathology', name: 'Renal Pathology', questions: 105 },
        { id: 'endocrine-pathology', name: 'Endocrine Pathology', questions: 90 },
        { id: 'reproductive-pathology-male', name: 'Reproductive Pathology (Male)', questions: 75 },
        { id: 'reproductive-pathology-female', name: 'Reproductive Pathology (Female)', questions: 75 },
        { id: 'nervous-system-pathology', name: 'Nervous System Pathology', questions: 105 },
        { id: 'musculoskeletal-pathology', name: 'Musculoskeletal Pathology', questions: 75 }
    ],

    // PHARMACOLOGY - 690 questions, 20 topics
    pharmacology: [
        { id: 'introduction-pharmacology', name: 'Introduction to Pharmacology', questions: 75 },
        { id: 'pharmacokinetics', name: 'Pharmacokinetics', questions: 90 },
        { id: 'pharmacodynamics', name: 'Pharmacodynamics', questions: 90 },
        { id: 'drug-metabolism', name: 'Drug Metabolism', questions: 75 },
        { id: 'drug-interactions', name: 'Drug Interactions', questions: 75 },
        { id: 'autonomic-nervous-system', name: 'Autonomic Nervous System', questions: 120 },
        { id: 'cholinergic-agents', name: 'Cholinergic Agents', questions: 75 },
        { id: 'adrenergic-agents', name: 'Adrenergic Agents', questions: 75 },
        { id: 'cardiovascular-drugs', name: 'Cardiovascular Drugs', questions: 120 },
        { id: 'renal-drugs', name: 'Renal Drugs', questions: 90 },
        { id: 'respiratory-drugs', name: 'Respiratory Drugs', questions: 75 },
        { id: 'gastrointestinal-drugs', name: 'Gastrointestinal Drugs', questions: 75 },
        { id: 'cns-drugs', name: 'CNS Drugs', questions: 105 },
        { id: 'anesthetic-agents', name: 'Anesthetic Agents', questions: 75 },
        { id: 'analgesic-agents', name: 'Analgesic Agents', questions: 75 },
        { id: 'endocrine-drugs', name: 'Endocrine Drugs', questions: 75 },
        { id: 'chemotherapy', name: 'Chemotherapy', questions: 90 },
        { id: 'antimicrobial-drugs', name: 'Antimicrobial Drugs', questions: 90 },
        { id: 'antifungal-antiviral', name: 'Antifungal & Antiviral', questions: 75 },
        { id: 'toxicology', name: 'Toxicology', questions: 90 }
    ],

    // MICROBIOLOGY - 690 questions, 20 topics
    microbiology: [
        { id: 'introduction-microbiology', name: 'Introduction to Microbiology', questions: 75 },
        { id: 'bacterial-structure', name: 'Bacterial Structure', questions: 75 },
        { id: 'bacterial-physiology', name: 'Bacterial Physiology', questions: 75 },
        { id: 'bacterial-genetics', name: 'Bacterial Genetics', questions: 90 },
        { id: 'sterilization-disinfection', name: 'Sterilization & Disinfection', questions: 75 },
        { id: 'bacteriology', name: 'Bacteriology', questions: 180 },
        { id: 'gram-positive-cocci', name: 'Gram‑Positive Cocci', questions: 75 },
        { id: 'gram-positive-bacilli', name: 'Gram‑Positive Bacilli', questions: 75 },
        { id: 'gram-negative-cocci', name: 'Gram‑Negative Cocci', questions: 75 },
        { id: 'gram-negative-bacilli', name: 'Gram‑Negative Bacilli', questions: 90 },
        { id: 'anaerobic-bacteria', name: 'Anaerobic Bacteria', questions: 75 },
        { id: 'mycobacteria', name: 'Mycobacteria', questions: 75 },
        { id: 'spirochetes', name: 'Spirochetes', questions: 75 },
        { id: 'virology', name: 'Virology', questions: 150 },
        { id: 'mycology', name: 'Mycology', questions: 90 },
        { id: 'parasitology', name: 'Parasitology', questions: 105 },
        { id: 'immunology', name: 'Immunology', questions: 120 },
        { id: 'antimicrobial-therapy', name: 'Antimicrobial Therapy', questions: 105 },
        { id: 'infection-control', name: 'Infection Control', questions: 90 }
    ]

};

// Pseudo-subject representing the "Slide View" card itself. It has no
// topics and is never studiable — it exists only so a caller who happens
// to ask getSubjectMeta('slide-view') gets something sensible instead of
// the generic { name: 'slide-view' } fallback. Not included in any of the
// getAll*() enumerations, since it isn't a real subject.
const SLIDE_VIEW_META = {
    name: 'Slide View',
    icon: 'fa-solid fa-images',
    color: '#6C5CE7',
    questions: 0,
};

// ==================== SLIDE MANIFEST CACHE (private) ====================
// `undefined` = not yet read. `null` = read, but no manifest on disk.
// Every mutation path in slide-data.js must call
// invalidateSlideManifestCache() **before** emitting status, so the
// Subjects-card subscriber never sees a stale manifest.
let _slideManifestCache = undefined;

function _readSlideManifest() {
    if (_slideManifestCache !== undefined) return _slideManifestCache;
    try {
        _slideManifestCache = utils.getLocalStorage('slideDataManifest', null);
    } catch {
        _slideManifestCache = null;
    }
    return _slideManifestCache;
}

/**
 * Drop the in-memory manifest copy so the next read picks up the latest
 * subject.json from localStorage.
 *
 * INTERNAL: only slide-data.js should call this. Any other caller
 * referencing this function means the abstraction is leaking — route the
 * need through one of the public getters instead.
 */
export function invalidateSlideManifestCache() {
    _slideManifestCache = undefined;
}


// ==================== PATH DETECTION ====================
function getPossibleUrls(subject, topicId) {
    const urls = [];
    // 1. Absolute from server root
    urls.push(`/data/questions/${subject}/${topicId}.json`);
    // 2. Relative from pages (../data/...)
    urls.push(`../data/questions/${subject}/${topicId}.json`);
    // 3. Relative from root (data/...)
    urls.push(`data/questions/${subject}/${topicId}.json`);
    // 4. Using window.location.origin
    urls.push(`${window.location.origin}/data/questions/${subject}/${topicId}.json`);
    // 5. For GitHub Pages sub‑paths
    const pathParts = window.location.pathname.split('/');
    if (pathParts.length > 1 && pathParts[1] !== 'pages') {
        urls.push(`/${pathParts[1]}/data/questions/${subject}/${topicId}.json`);
        urls.push(`/${pathParts[1]}/pages/../data/questions/${subject}/${topicId}.json`);
    }
    return urls;
}

async function fetchWithFallbacks(urls) {
    for (const url of urls) {
        try {
            console.log(`[Questions] Trying: ${url}`);
            const response = await fetch(url);
            if (response.ok) {
                console.log(`[Questions] Success: ${url}`);
                return await response.json();
            } else {
                console.warn(`[Questions] HTTP ${response.status} for ${url}`);
            }
        } catch (e) {
            console.warn(`[Questions] Fetch failed for ${url}: ${e.message}`);
        }
    }
    throw new Error('All fetch attempts failed');
}

function generateFallbackQuestions(subject, topicId, count = 10) {
    const questions = [];
    for (let i = 0; i < count; i++) {
        questions.push({
            id: `${subject}_${topicId}_${i}`,
            subject,
            topic: topicId,
            question: `Sample question ${i + 1} for ${topicId}?`,
            options: ['Option A', 'Option B', 'Option C', 'Option D', 'Option E'],
            correct: 'A',
            explanation: `This is a sample explanation for question ${i + 1}.`,
            difficulty: Math.floor(Math.random() * 5) + 1,
            image: null
        });
    }
    return questions;
}

async function loadTopicQuestions(subject, topicId) {
    const urls = getPossibleUrls(subject, topicId);
    try {
        const data = await fetchWithFallbacks(urls);
        console.log('[Questions] data received:', data);
        // Handle both array and object with 'questions' property
        let questionsArray = null;
        if (Array.isArray(data)) {
            questionsArray = data;
        } else if (data && Array.isArray(data.questions)) {
            questionsArray = data.questions;
        } else {
            console.warn(`[Questions] Unexpected data format for ${subject}/${topicId}, using fallback.`);
            return generateFallbackQuestions(subject, topicId, 10);
        }
        return questionsArray.map(q => ({
            ...q,
            subject,
            topic: topicId
        }));
    } catch (err) {
        console.error(`[Questions] Failed to load ${subject}/${topicId}, using fallback.`, err);
        return generateFallbackQuestions(subject, topicId, 10);
    }
}

// ==================== PUBLIC API ====================

/**
 * Return metadata for a subject, merging in any subject contributed by
 * the slide zip. Precedence: slide manifest > static bank > generic
 * fallback, so a zip can rebrand or recolour an existing subject without
 * an app release.
 *
 * `source` tells callers where the record came from — the only field
 * downstream ever needs to distinguish slide from static:
 *   'slide'   — declared by the slide zip's subject.json
 *   'static'  — one of the built-in SUBJECT_META entries
 *   'special' — the "slide-view" pseudo-subject (the card itself)
 *   'unknown' — no match anywhere (subjectId echoed back as name)
 *
 * @param   {string} subjectId
 * @returns {{ name: string, icon: string, color: string,
 *             questions: number,
 *             source: 'slide'|'static'|'special'|'unknown' }}
 */
export function getSubjectMeta(subjectId) {
    if (subjectId === 'slide-view') {
        return { ...SLIDE_VIEW_META, source: 'special' };
    }

    const m = _readSlideManifest();
    if (m?.SUBJECT_META?.[subjectId]) {
        return { ...m.SUBJECT_META[subjectId], source: 'slide' };
    }

    if (SUBJECT_META[subjectId]) {
        return { ...SUBJECT_META[subjectId], source: 'static' };
    }

    return { name: subjectId, icon: '📚', color: '#888', questions: 0, source: 'unknown' };
}

/**
 * Return the topic list for a subject, merging in any topics delivered
 * by the slide zip. Same precedence rule as getSubjectMeta.
 *
 * `'slide-view'` returns [] — it is the card, not a studiable subject.
 *
 * @param   {string} subjectId
 * @returns {Array<{ id: string, name: string, questions: number }>}
 */
export function getTopicsBySubject(subjectId) {
    if (subjectId === 'slide-view') return [];

    const m = _readSlideManifest();
    if (m?.TOPICS?.[subjectId]) return m.TOPICS[subjectId];

    return TOPICS[subjectId] || [];
}

/**
 * Single topic by id, or null. Uniform across slide and static subjects.
 *
 * @param   {string} subjectId
 * @param   {string} topicId
 * @returns {{ id: string, name: string, questions: number } | null}
 */
export function getTopicById(subjectId, topicId) {
    return getTopicsBySubject(subjectId).find(t => t.id === topicId) || null;
}

/**
 * Every subject id — static + slide — in a stable order (static first,
 * then slide-only subjects). Deduped: a subject appearing in both banks
 * is listed once. Excludes the 'slide-view' pseudo-subject.
 *
 * @returns {string[]}
 */
export function getAllSubjectIds() {
    const ids = new Set(Object.keys(SUBJECT_META));
    const m = _readSlideManifest();
    if (m?.SUBJECT_META) {
        for (const id of Object.keys(m.SUBJECT_META)) ids.add(id);
    }
    return [...ids];
}

/**
 * Static subject ids only (the built-in SUBJECT_META bank).
 * @returns {string[]}
 */
export function getAllStaticSubjectIds() {
    return Object.keys(SUBJECT_META);
}

/**
 * Slide-delivered subject ids only. Empty array until a zip has been
 * downloaded. Excludes the 'slide-view' pseudo-subject.
 * @returns {string[]}
 */
export function getAllSlideSubjectIds() {
    const m = _readSlideManifest();
    return m?.SUBJECT_META ? Object.keys(m.SUBJECT_META) : [];
}

/**
 * Full list of subjects as flat objects, with topics nested. The
 * subject's raw metadata (including any custom fields the zip's author
 * added to subject.json) is spread onto each entry, plus `id`,
 * `source`, and `topics`.
 *
 * Use this for list views (performance, results, subject choosers) so
 * they never need to know whether a subject came from the static bank
 * or the slide zip.
 *
 * @returns {Array<Object>}
 */
export function getAllSubjects() {
    return getAllSubjectIds().map(id => {
        const meta = getSubjectMeta(id);
        return {
            id,
            ...meta,
            topics: getTopicsBySubject(id),
        };
    });
}

/**
 * Load the questions for an exam.
 *
 * Slide subjects have no network source — their questions live only in
 * IndexedDB, populated by slide-data.js at download time. If any
 * requested topic of a slide subject isn't cached, this throws rather
 * than generating placeholder questions (which would silently pollute
 * the user's analytics with fake attempts).
 *
 * @param   {{ subject: string, topics: Array<string|{id:string}>, questionCount: number }}
 * @returns {Promise<Array<Object>>}
 */
export async function getQuestionsForExam(config) {
    const { subject, topics: selectedTopics, questionCount } = config;

    if (!subject) throw new Error('Subject missing in exam config');
    if (!selectedTopics || selectedTopics.length === 0) throw new Error('No topics selected');
    if (!questionCount || questionCount < 1) throw new Error('Invalid question count');

    // Normalize to array of topic IDs (strings)
    const topicIds = selectedTopics.map(t =>
        (typeof t === 'object' && t.id) ? t.id : (typeof t === 'string' ? t : String(t))
    );

    // Check cache in IndexedDB
    const cachedTopics = {};
    for (const topicId of topicIds) {
        const existing = await db.getQuestions({ subject, topic: topicId });
        if (existing && existing.length > 0) {
            cachedTopics[topicId] = existing;
        }
    }

    // Slide subjects have no network source. Guard: if any requested
    // topic of a slide subject isn't cached, throw a clear error rather
    // than letting loadTopicQuestions generate placeholder questions
    // that would poison the user's analytics.
    const m = _readSlideManifest();
    if (m?.TOPICS?.[subject]) {
        const missing = topicIds.filter(id => !cachedTopics[id]);
        if (missing.length > 0) {
            throw new Error(
                `Slide data not downloaded (missing topics: ${missing.join(', ')}). ` +
                `Open Subjects → Slide View and download it first.`
            );
        }
    }

    // Load missing topics (non-slide subjects only — the guard above
    // ensures every slide topic is already cached by this point).
    const loadPromises = topicIds.map(async (topicId) => {
        if (cachedTopics[topicId]) return cachedTopics[topicId];
        const questions = await loadTopicQuestions(subject, topicId);
        await db.saveQuestions(questions);
        return questions;
    });

    const topicQuestionArrays = await Promise.all(loadPromises);
    const allQuestions = topicQuestionArrays.flat();

    if (allQuestions.length === 0) {
        throw new Error('No questions available for the selected topics');
    }

    const shuffled = utils.shuffleArray(allQuestions);
    return shuffled.slice(0, questionCount);
}

/**
 * Fetch a specific set of questions by id, from whatever's in IndexedDB.
 * Works for both static and slide subjects (both save to the same store).
 *
 * @param   {string[]} ids
 * @returns {Promise<Array<Object>>}
 */
export async function getQuestionsByIds(ids) {
    const all = await db.getAllQuestions();
    return all.filter(q => ids.includes(q.id));
}