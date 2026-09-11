'use strict';

/* ==================================================================
 * 1. CONFIGURATION & CONSTANTS
 * ================================================================== */

const DATA_URLS = {
    nouns: './assets/nouns.json',
    verbs: './assets/verbs.json',
};

const STORAGE_KEYS = {
    theme: 'dm_theme',
    xp: 'dm_xp',
    streak: 'dm_streak',
    maxStreak: 'dm_max_streak',
};

const XP_REWARD = {
    noun: 15,
    verb: 30,
};

const AUTO_ADVANCE_DELAY_MS = {
    noun: 1300,
    verb: 1500,
};

const HISTORY_MAX_SIZE = 30;   // how many recently-seen words we avoid repeating
const HISTORY_RECYCLE_SIZE = 5; // kept entries when the pool is exhausted and reset

const MILESTONE_INTERVAL = 10;    // streak count that triggers a celebration
const MAX_TIER_INDEX = 5;         // caps visual tier styling at tier-5 ("Rainbow God")
const MILESTONE_TOAST_DURATION_MS = 3500;

const TIER_NAMES = ['Bronze', 'Emerald', 'Cyan', 'Purple', 'Gold Master', 'Rainbow God'];

// Canonical person order shared by conjugation data, table rows and inputs.
const PERSONS = [
    { key: 'ich', label: 'ich' },
    { key: 'du', label: 'du' },
    { key: 'er', label: 'er/sie/es' },
    { key: 'wir', label: 'wir' },
    { key: 'ihr', label: 'ihr' },
    { key: 'sie', label: 'sie/Sie' },
];
// e.g. { ich: 0, du: 1, er: 2, wir: 3, ihr: 4, sie: 5 }
const PERSON_INDEX = Object.fromEntries(PERSONS.map((person, index) => [person.key, index]));

const FEEDBACK_STYLE = {
    success: 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800',
    error: 'bg-rose-100 dark:bg-rose-950/80 text-rose-900 dark:text-rose-200 border border-rose-300 dark:border-rose-800',
    warning: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-800',
};

const TAB_BUTTON_CLASS = {
    active: {
        nouns: 'px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center space-x-2 bg-indigo-600 text-white shadow-md',
        verbs: 'px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center space-x-2 bg-purple-600 text-white shadow-md',
    },
    inactive: 'px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center space-x-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200',
};

/* ==================================================================
 * 2. AUDIO ENGINE
 *    Tiny Web Audio synthesizer for correct/incorrect/milestone cues.
 * ================================================================== */

class SoundFX {
    constructor() {
        this.ctx = null;
    }

    /** Lazily creates the AudioContext (must happen after a user gesture). */
    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    playCorrect() {
        this.init();
        const now = this.ctx.currentTime;
        const osc1 = this.ctx.createOscillator();
        const osc2 = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc1.type = 'sine';
        osc2.type = 'triangle';
        osc1.frequency.setValueAtTime(523.25, now);        // C5
        osc1.frequency.setValueAtTime(659.25, now + 0.1);  // E5
        osc2.frequency.setValueAtTime(1046.50, now + 0.1); // C6

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.35);
        osc2.stop(now + 0.35);
    }

    playWrong() {
        this.init();
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.25);

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.25);
    }

    playMilestoneFanfare() {
        this.init();
        const now = this.ctx.currentTime;
        const notes = [440, 554.37, 659.25, 880]; // A major arpeggio

        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const noteTime = now + i * 0.08;

            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, noteTime);

            gain.gain.setValueAtTime(0.12, noteTime);
            gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.3);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(noteTime);
            osc.stop(noteTime + 0.3);
        });
    }
}

/* ==================================================================
 * 3. FIREWORKS ENGINE
 *    Lightweight canvas particle system for milestone celebrations.
 * ================================================================== */

class PixelFireworksEngine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.animationFrameId = null;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    /** Launches a short volley of staggered bursts across the top of the screen. */
    triggerShow() {
        const colors = ['#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ec4899', '#efa107', '#ffffff'];
        const burstCount = 6;
        const burstDelayMs = 220;

        for (let i = 0; i < burstCount; i++) {
            setTimeout(() => {
                const x = Math.random() * (this.canvas.width * 0.7) + this.canvas.width * 0.15;
                const y = Math.random() * (this.canvas.height * 0.4) + this.canvas.height * 0.1;
                this.createBurst(x, y, colors);
            }, i * burstDelayMs);
        }
    }

    createBurst(x, y, colors) {
        const particleCount = 60;
        const pixelSize = 4;

        for (let i = 0; i < particleCount; i++) {
            const angle = (Math.PI * 2 * i) / particleCount + Math.random() * 0.2;
            const speed = Math.random() * 7 + 2;

            this.particles.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: Math.random() > 0.5 ? pixelSize : pixelSize * 1.5,
                color: colors[Math.floor(Math.random() * colors.length)],
                alpha: 1,
                decay: Math.random() * 0.02 + 0.015,
                gravity: 0.12,
            });
        }

        if (!this.animationFrameId) {
            this.animate();
        }
    }

    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += p.gravity;
            p.alpha -= p.decay;

            if (p.alpha <= 0) {
                this.particles.splice(i, 1);
                continue;
            }

            this.ctx.fillStyle = p.color;
            this.ctx.globalAlpha = Math.max(0, p.alpha);
            this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
        }

        if (this.particles.length > 0) {
            this.animationFrameId = requestAnimationFrame(() => this.animate());
        } else {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.animationFrameId = null;
        }
    }
}

const sfx = new SoundFX();
const fireworks = new PixelFireworksEngine('fireworksCanvas');

/* ==================================================================
 * 4. APPLICATION STATE
 * ================================================================== */

/** @type {Array<{w:string,g:string,m:string,p:string}>} */
let nounsData = [];
/** @type {Array<{w:string,m:string,pres:string[],praet:string[],perf:string[]}>} */
let verbsData = [];

const state = {
    xp: parseInt(localStorage.getItem(STORAGE_KEYS.xp) || '0', 10),
    streak: parseInt(localStorage.getItem(STORAGE_KEYS.streak) || '0', 10),
    maxStreak: parseInt(localStorage.getItem(STORAGE_KEYS.maxStreak) || '0', 10),

    selectedGender: null,
    selectedTense: 'pres', // 'pres' | 'praet' | 'perf'

    currentNoun: null,
    currentVerb: null,

    activeTab: 'nouns', // 'nouns' | 'verbs'
    isModalOpen: false,

    // Spaced-repetition buffers: recently-seen words are avoided until
    // the pool of "unseen" items runs out, then the oldest are recycled.
    nounHistory: [],
    verbHistory: [],
};

/* ==================================================================
 * 5. DOM ELEMENT CACHE
 * ================================================================== */

const dom = {
    // Dashboard
    xpDisplay: document.getElementById('xpDisplay'),
    streakDisplay: document.getElementById('streakDisplay'),
    maxStreakDisplay: document.getElementById('maxStreakDisplay'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    tierLabel: document.getElementById('tierLabel'),

    // Tabs & sections
    tabNouns: document.getElementById('tabNouns'),
    tabVerbs: document.getElementById('tabVerbs'),
    nounSection: document.getElementById('nounSection'),
    verbSection: document.getElementById('verbSection'),

    // Noun practice
    nounWord: document.getElementById('nounWord'),
    nounMeaning: document.getElementById('nounMeaning'),
    pluralInput: document.getElementById('pluralInput'),
    checkNounBtn: document.getElementById('checkNounBtn'),
    skipNounBtn: document.getElementById('skipNounBtn'),
    nounFeedback: document.getElementById('nounFeedback'),
    genderBtns: document.querySelectorAll('.gender-btn'),

    // Verb practice
    verbInfinitive: document.getElementById('verbInfinitive'),
    verbMeaning: document.getElementById('verbMeaning'),
    checkVerbBtn: document.getElementById('checkVerbBtn'),
    skipVerbBtn: document.getElementById('skipVerbBtn'),
    toggleTableBtn: document.getElementById('toggleTableBtn'),
    verbFeedback: document.getElementById('verbFeedback'),
    tenseBtns: document.querySelectorAll('.tense-btn'),
    conjInputs: {
        ich: document.getElementById('conj_ich'),
        du: document.getElementById('conj_du'),
        er: document.getElementById('conj_er'),
        wir: document.getElementById('conj_wir'),
        ihr: document.getElementById('conj_ihr'),
        sie: document.getElementById('conj_sie'),
    },

    // Conjugation modal
    tableModal: document.getElementById('tableModal'),
    closeModalBtn: document.getElementById('closeModalBtn'),
    modalVerbTitle: document.getElementById('modalVerbTitle'),
    modalVerbMeaning: document.getElementById('modalVerbMeaning'),
    modalTableBody: document.getElementById('modalTableBody'),

    // Misc
    milestoneToast: document.getElementById('milestoneToast'),
    milestoneToastText: document.getElementById('milestoneToastText'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeIcon: document.getElementById('themeIcon'),
    themeLabel: document.getElementById('themeLabel'),
};

/* ==================================================================
 * 6. THEME (LIGHT / DARK MODE)
 * ================================================================== */

function initTheme() {
    const storedTheme = localStorage.getItem(STORAGE_KEYS.theme);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = storedTheme === 'dark' || (!storedTheme && prefersDark);

    document.documentElement.classList.toggle('dark', isDark);
    updateThemeUI(isDark);
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem(STORAGE_KEYS.theme, isDark ? 'dark' : 'light');
    updateThemeUI(isDark);
}

function updateThemeUI(isDark) {
    dom.themeIcon.textContent = isDark ? '🌙' : '☀️';
    dom.themeLabel.textContent = isDark ? 'Dark Mode' : 'Light Mode';
}

/* ==================================================================
 * 7. PERSISTENCE (XP / STREAK)
 * ================================================================== */

function saveProgress() {
    localStorage.setItem(STORAGE_KEYS.xp, state.xp);
    localStorage.setItem(STORAGE_KEYS.streak, state.streak);
    localStorage.setItem(STORAGE_KEYS.maxStreak, state.maxStreak);
}

/* ==================================================================
 * 8. DATA LOADING & BOOTSTRAP
 * ================================================================== */

async function loadVocabularyData() {
    try {
        const [nounsResponse, verbsResponse] = await Promise.all([
            fetch(DATA_URLS.nouns),
            fetch(DATA_URLS.verbs),
        ]);

        if (!nounsResponse.ok || !verbsResponse.ok) {
            throw new Error('Failed to load JSON datasets.');
        }

        nounsData = await nounsResponse.json();
        verbsData = await verbsResponse.json();

        initApp();
    } catch (error) {
        console.error('Error loading language datasets:', error);
        alert('Could not load vocabulary data. Please check your network or local server.');
    }
}

function initApp() {
    initTheme();
    updateDashboardUI();
    bindEvents();
    nextNoun();
    nextVerb();
}

/* ==================================================================
 * 9. SPACED-REPETITION SELECTION
 *    Shared helper: picks a random item not seen recently, recycling
 *    the history once every item in the pool has been used.
 * ================================================================== */

function pickNextWithSpacedHistory(dataset, history) {
    let available = dataset.filter((item) => !history.includes(item.w));

    if (available.length === 0) {
        history.splice(0, history.length - HISTORY_RECYCLE_SIZE);
        available = dataset.filter((item) => !history.includes(item.w));
    }

    const chosen = available[Math.floor(Math.random() * available.length)];

    history.push(chosen.w);
    if (history.length > HISTORY_MAX_SIZE) {
        history.shift();
    }

    return chosen;
}

/* ==================================================================
 * 10. STREAK & MILESTONE HANDLING
 * ================================================================== */

function handleStreakIncrement(pointsAwarded) {
    state.streak += 1;
    state.xp += pointsAwarded;
    state.maxStreak = Math.max(state.maxStreak, state.streak);

    saveProgress();
    updateDashboardUI();

    if (state.streak > 0 && state.streak % MILESTONE_INTERVAL === 0) {
        triggerMilestoneReward();
    } else {
        sfx.playCorrect();
    }
}

function resetStreak() {
    state.streak = 0;
    saveProgress();
    updateDashboardUI();
    sfx.playWrong();
}

function triggerMilestoneReward() {
    sfx.playMilestoneFanfare();
    fireworks.triggerShow();

    const currentTier = Math.floor(state.streak / MILESTONE_INTERVAL);
    dom.milestoneToastText.textContent = `🔥 Magnificent ${state.streak} Streak! Tier ${currentTier + 1} Unlocked!`;
    dom.milestoneToast.classList.remove('hidden');

    setTimeout(() => {
        dom.milestoneToast.classList.add('hidden');
    }, MILESTONE_TOAST_DURATION_MS);
}

/* ==================================================================
 * 11. DASHBOARD RENDERING
 * ================================================================== */

function updateDashboardUI() {
    dom.xpDisplay.textContent = `${state.xp} XP`;
    dom.streakDisplay.textContent = state.streak;
    dom.maxStreakDisplay.textContent = state.maxStreak;

    const streakInTier = state.streak % MILESTONE_INTERVAL;
    const currentTier = Math.floor(state.streak / MILESTONE_INTERVAL);
    const progressPercent = (streakInTier / MILESTONE_INTERVAL) * 100;

    dom.progressText.textContent = `${streakInTier} / ${MILESTONE_INTERVAL} Streak`;
    dom.progressBar.style.width = `${progressPercent}%`;

    const tierName = TIER_NAMES[Math.min(currentTier, TIER_NAMES.length - 1)];
    dom.tierLabel.textContent = `Tier ${currentTier + 1}: ${tierName}`;

    const tierClass = `tier-${Math.min(currentTier, MAX_TIER_INDEX)}`;
    dom.progressBar.className = `h-full rounded-full transition-all duration-500 ease-out ${tierClass}`;
}

/* ==================================================================
 * 12. NOUN PRACTICE
 * ================================================================== */

function nextNoun() {
    state.currentNoun = pickNextWithSpacedHistory(nounsData, state.nounHistory);
    state.selectedGender = null;

    dom.nounWord.textContent = state.currentNoun.w;
    dom.nounMeaning.textContent = `🇬🇧 ${state.currentNoun.m}`;
    dom.pluralInput.value = '';
    dom.nounFeedback.classList.add('hidden');

    dom.genderBtns.forEach((btn) => {
        btn.setAttribute('aria-pressed', 'false');
        btn.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-100', 'dark:bg-indigo-950/60');
    });
}

function checkNounAnswer() {
    if (!state.currentNoun) return;

    const userGender = state.selectedGender;
    const userPlural = dom.pluralInput.value.trim();

    if (!userGender) {
        showFeedback(dom.nounFeedback, '⚠️ Please select a gender (der, die, or das).', FEEDBACK_STYLE.warning);
        return;
    }

    const isGenderCorrect = userGender === state.currentNoun.g;
    const isPluralCorrect = userPlural.toLowerCase() === state.currentNoun.p.toLowerCase();

    if (isGenderCorrect && isPluralCorrect) {
        const message = `🎉 Perfect! ${state.currentNoun.g} ${state.currentNoun.w}, Plural: die ${state.currentNoun.p} (+${XP_REWARD.noun} XP)`;
        showFeedback(dom.nounFeedback, message, FEEDBACK_STYLE.success);
        handleStreakIncrement(XP_REWARD.noun);
        setTimeout(nextNoun, AUTO_ADVANCE_DELAY_MS.noun);
    } else {
        const message = `❌ Incorrect. Correct answer: <strong>${state.currentNoun.g} ${state.currentNoun.w}</strong> (Plural: <strong>die ${state.currentNoun.p}</strong>)`;
        showFeedback(dom.nounFeedback, message, FEEDBACK_STYLE.error);
        resetStreak();
    }
}

/* ==================================================================
 * 13. VERB PRACTICE
 * ================================================================== */

function nextVerb() {
    state.currentVerb = pickNextWithSpacedHistory(verbsData, state.verbHistory);

    dom.verbInfinitive.textContent = state.currentVerb.w;
    dom.verbMeaning.textContent = `🇬🇧 ${state.currentVerb.m}`;
    dom.verbFeedback.classList.add('hidden');

    const tenseForm = state.currentVerb[state.selectedTense] || [];
    Object.entries(dom.conjInputs).forEach(([person, input]) => {
        input.value = '';
        input.classList.remove('border-rose-500', 'border-emerald-500');
    });

    if (state.isModalOpen) {
        renderConjugationModal();
    }
}

function checkVerbAnswer() {
    if (!state.currentVerb) return;

    const targetForms = state.currentVerb[state.selectedTense];
    if (!targetForms) return;

    let allCorrect = true;

    Object.entries(dom.conjInputs).forEach(([person, input]) => {
        const userValue = input.value.trim().toLowerCase();
        const expected = targetForms[PERSON_INDEX[person]].toLowerCase();
        const isCorrect = userValue === expected;

        input.classList.toggle('border-emerald-500', isCorrect);
        input.classList.toggle('border-rose-500', !isCorrect);

        if (!isCorrect) allCorrect = false;
    });

    if (allCorrect) {
        const message = `🎉 Excellent! Perfect conjugation for "${state.currentVerb.w}"! (+${XP_REWARD.verb} XP)`;
        showFeedback(dom.verbFeedback, message, FEEDBACK_STYLE.success);
        handleStreakIncrement(XP_REWARD.verb);
        setTimeout(nextVerb, AUTO_ADVANCE_DELAY_MS.verb);
    } else {
        const message = '❌ Incorrect. Correct conjugations: '
            + PERSONS.map((p) => `${p.label} <strong>${targetForms[PERSON_INDEX[p.key]]}</strong>`).join(', ')
            + '.';
        showFeedback(dom.verbFeedback, message, FEEDBACK_STYLE.error);
        resetStreak();
    }
}

/* ==================================================================
 * 14. CONJUGATION TABLE MODAL ("Teach Me!")
 * ================================================================== */

function renderConjugationModal() {
    if (!state.currentVerb) return;

    const verb = state.currentVerb;
    // The title node is "<infinitive> <span>meaning</span>" — only the
    // leading text node is replaced so the meaning span stays intact.
    dom.modalVerbTitle.childNodes[0].textContent = `${verb.w} `;
    dom.modalVerbMeaning.textContent = `🇬🇧 ${verb.m}`;

    const pres = verb.pres || [];
    const praet = verb.praet || [];
    const perf = verb.perf || [];

    dom.modalTableBody.innerHTML = PERSONS.map((person, index) => `
        <tr class="hover:bg-slate-100 dark:hover:bg-slate-800/40 transition-colors">
            <td class="py-2.5 px-3 font-sans font-bold text-slate-500 dark:text-slate-400 text-xs">${person.label}</td>
            <td class="py-2.5 px-3 text-emerald-600 dark:text-emerald-300 font-medium">${pres[index] || '-'}</td>
            <td class="py-2.5 px-3 text-cyan-600 dark:text-cyan-300 font-medium">${praet[index] || '-'}</td>
            <td class="py-2.5 px-3 text-purple-600 dark:text-purple-300 font-medium">${perf[index] || '-'}</td>
        </tr>
    `).join('');
}

function openModal() {
    if (state.activeTab !== 'verbs') return;
    renderConjugationModal();
    dom.tableModal.classList.remove('hidden');
    state.isModalOpen = true;
}

function closeModal() {
    dom.tableModal.classList.add('hidden');
    state.isModalOpen = false;
}

function toggleModal() {
    state.isModalOpen ? closeModal() : openModal();
}

/* ==================================================================
 * 15. SHARED UI HELPERS
 * ================================================================== */

function showFeedback(element, htmlContent, colorClasses) {
    element.innerHTML = htmlContent;
    element.className = `max-w-xl mx-auto mt-4 p-4 rounded-xl text-center font-semibold text-sm transition-all ${colorClasses}`;
    element.classList.remove('hidden');
}

function switchTab(tab) {
    state.activeTab = tab;
    const isNouns = tab === 'nouns';

    dom.tabNouns.className = isNouns ? TAB_BUTTON_CLASS.active.nouns : TAB_BUTTON_CLASS.inactive;
    dom.tabVerbs.className = isNouns ? TAB_BUTTON_CLASS.inactive : TAB_BUTTON_CLASS.active.verbs;
    dom.nounSection.classList.toggle('hidden', !isNouns);
    dom.verbSection.classList.toggle('hidden', isNouns);

    if (isNouns) closeModal();
}

/* ==================================================================
 * 16. EVENT BINDING
 * ================================================================== */

function bindEvents() {
    dom.themeToggleBtn.addEventListener('click', toggleTheme);

    dom.tabNouns.addEventListener('click', () => switchTab('nouns'));
    dom.tabVerbs.addEventListener('click', () => switchTab('verbs'));

    dom.toggleTableBtn.addEventListener('click', toggleModal);
    dom.closeModalBtn.addEventListener('click', closeModal);
    dom.tableModal.addEventListener('click', (e) => {
        if (e.target === dom.tableModal) closeModal();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && state.activeTab === 'verbs') {
            e.preventDefault();
            toggleModal();
        }
        if (e.key === 'Escape' && state.isModalOpen) {
            closeModal();
        }
    });

    dom.tenseBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            dom.tenseBtns.forEach((b) => {
                b.classList.remove('bg-purple-600', 'text-white');
                b.classList.add('text-slate-600', 'dark:text-slate-400');
            });

            const selectedBtn = e.currentTarget;
            selectedBtn.classList.add('bg-purple-600', 'text-white');
            selectedBtn.classList.remove('text-slate-600', 'dark:text-slate-400');

            state.selectedTense = selectedBtn.dataset.tense;
        });
    });

    dom.genderBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            dom.genderBtns.forEach((b) => {
                b.setAttribute('aria-pressed', 'false');
                b.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-100', 'dark:bg-indigo-950/60');
            });

            const selectedBtn = e.currentTarget;
            selectedBtn.setAttribute('aria-pressed', 'true');
            selectedBtn.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-100', 'dark:bg-indigo-950/60');
            state.selectedGender = selectedBtn.dataset.gender;
        });
    });

    dom.checkNounBtn.addEventListener('click', checkNounAnswer);
    dom.skipNounBtn.addEventListener('click', nextNoun);
    dom.pluralInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') checkNounAnswer();
    });

    dom.checkVerbBtn.addEventListener('click', checkVerbAnswer);
    dom.skipVerbBtn.addEventListener('click', nextVerb);
    Object.values(dom.conjInputs).forEach((input) => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') checkVerbAnswer();
        });
    });
}

/* ==================================================================
 * 17. BOOTSTRAP
 * ================================================================== */

window.addEventListener('load', loadVocabularyData);